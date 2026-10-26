import assert from 'node:assert/strict';
import { runAntennaReference, runGroundLinkLabel, runLineOfSight } from './runReference.ts';

const links = {
  uplink: {
    spacecraft_antenna: 'wire',
    frequency_hz: 438e6,
    antenna_orientation_deg: [10, 20, 30],
  },
  downlink: {
    spacecraft_antenna: 'patch',
    frequency_hz: 2.4e9,
    antenna_orientation_deg: [-40, 5, 60],
  },
};
const snapshot = {
  scenario: { antenna_variant: 'v45', uplink: { frequency_hz: 999 }, downlink: {} },
  run: {
    run_id: 'computed',
    result: {
      manifest: {
        scenario: { antenna_variant: 'turnstile', ...links },
        frames: {
          inertial: 'FIXED_EPOCH_MEAN_EQUATOR_EQUINOX_APPROX',
          quaternion: 'Hamilton scalarfirst q_B_from_I',
        },
      },
      samples: {
        time_s: [0, 30],
        satellite_position_m: [
          [7000000, 0, 0],
          [7000000, 10, 0],
        ],
        station_position_m: [
          [6000000, 0, 0],
          [6000000, 10, 10],
        ],
        q_body_from_inertial_wxyz: [
          [1, 0, 0, 0],
          [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        ],
        visible: [false, true],
        active_direction: ['downlink', 'uplink'],
        radio_active: [true, true],
      },
    },
  },
};
const original = structuredClone(snapshot);
for (const direction of ['uplink', 'downlink']) {
  const selected = runAntennaReference(snapshot, direction);
  assert.equal(selected.reason, null);
  assert.strictEqual(selected.request.link, links[direction]);
  assert.equal(selected.request.antenna_variant, 'turnstile');
}
assert.equal(runAntennaReference(null, 'uplink').request, null);
const missing = structuredClone(snapshot);
delete missing.run.result.manifest.scenario;
assert.equal(
  runAntennaReference(missing, 'uplink').request,
  null,
  'Missing archive never falls back to draft',
);
const unsupported = structuredClone(snapshot);
unsupported.run.result.manifest.scenario.antenna_variant = 'v45';
assert.equal(
  runAntennaReference(unsupported, 'uplink').request.antenna_variant,
  'v45',
  'Archived unresolved field stays unresolved',
);
const selected = runLineOfSight(snapshot, 1);
assert.equal(selected.reason, null);
assert.strictEqual(
  selected.probe.spacecraft_position_m,
  snapshot.run.result.samples.satellite_position_m[1],
);
assert.strictEqual(
  selected.probe.station_position_m,
  snapshot.run.result.samples.station_position_m[1],
);
assert.strictEqual(
  selected.probe.q_body_from_inertial_wxyz,
  snapshot.run.result.samples.q_body_from_inertial_wxyz[1],
);
for (const index of [-1, 2, 0.5, NaN]) assert.equal(runLineOfSight(snapshot, index).probe, null);
for (const change of [
  (s) => {
    s.run.result.manifest.frames = {};
  },
  (s) => {
    s.run.result.manifest.frames.inertial = 'ITRF';
  },
  (s) => {
    s.run.result.manifest.frames.quaternion = 'xyzw';
  },
  (s) => {
    s.run.result.samples.satellite_position_m[1] = [NaN, 0, 0];
  },
  (s) => {
    s.run.result.samples.station_position_m[1] = s.run.result.samples.satellite_position_m[1];
  },
  (s) => {
    s.run.result.samples.q_body_from_inertial_wxyz[1] = [0, 0, 0, 0];
  },
  (s) => {
    s.run.result.samples.q_body_from_inertial_wxyz[1] = [1, 0, 0];
  },
]) {
  const invalid = structuredClone(snapshot);
  change(invalid);
  assert.equal(runLineOfSight(invalid, 1).probe, null);
}
const legacy = structuredClone(snapshot);
legacy.run.result.manifest.frames = {
  inertial: 'ANALYTIC_INERTIAL: Earth-fixed XYZ coincident at pass midpoint; not GCRF/TEME',
  quaternion: 'scalar-first Hamilton q_body_from_inertial: q [0,v_I] conjugate(q) = [0,v_B]',
};
assert(runLineOfSight(legacy, 1).probe, 'A real archived legacy run uses its own declared frame');
assert.equal(runGroundLinkLabel(snapshot, 'downlink', 0), 'Below station mask · geometric LOS');
assert.equal(runGroundLinkLabel(snapshot, 'downlink', 1), 'DL not scheduled · geometric LOS');
assert.equal(runGroundLinkLabel(snapshot, 'uplink', 1), 'Ground visible · scheduled direction');
legacy.run.result.samples.radio_active[1] = false;
assert.equal(runGroundLinkLabel(legacy, 'uplink', 1), 'Radio idle · geometric LOS');
assert.equal(runGroundLinkLabel(snapshot, 'uplink', 3), 'Ground visibility unavailable');
assert.deepEqual(snapshot, original);
console.log(
  'Run antenna references passed: immutable archive/direction selection, no draft fallback, preserved unresolved installed field, exact sampled geometry, declared frame gate and blocked/idle/unscheduled ground labels.',
);

const coupled = structuredClone(snapshot);
coupled.scenario.power = { transmit_radiation_efficiency: 0.99 };
coupled.run.result.manifest.scenario.power = {
  analytical_efficiency_semantics: 'pattern_times_additional_v1',
  transmit_radiation_efficiency: 0.25,
};
for (const direction of ['uplink', 'downlink']) {
  const request = runAntennaReference(coupled, direction).request;
  assert.equal(request.direction, direction);
  assert.equal(request.analytical_efficiency_semantics, 'pattern_times_additional_v1');
  assert.equal(request.analytical_radiation_efficiency, 0.25);
}
for (const efficiency of [undefined, null, NaN, -0.1, 1.1]) {
  const invalid = structuredClone(coupled);
  invalid.run.result.manifest.scenario.power.transmit_radiation_efficiency = efficiency;
  assert.equal(runAntennaReference(invalid, 'downlink').request, null);
}
const oldPower = structuredClone(coupled);
oldPower.run.result.manifest.scenario.power.analytical_efficiency_semantics = null;
assert.equal(
  runAntennaReference(oldPower, 'downlink').request.analytical_efficiency_semantics,
  undefined,
);
const unknownRevision = structuredClone(coupled);
unknownRevision.run.result.manifest.scenario.power.analytical_efficiency_semantics = 'future';
assert.equal(runAntennaReference(unknownRevision, 'downlink').request, null);
console.log(
  'Archived RF efficiency context passed: direction, exact additional factor, legacy omission and no draft fallback.',
);
