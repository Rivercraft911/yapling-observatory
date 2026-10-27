import assert from 'node:assert/strict';
import { LiveHistory } from './liveHistory.ts';

const input = {
  name: 'Test',
  orbit: { elements: { epoch_utc: '2026-10-25T00:00:00Z' } },
  duration_s: 100,
  clocks: { output_step_s: 10 },
  station: {},
  uplink: {},
  downlink: {},
  schedule: {},
  provenance: [],
};
const row = (t) => ({
  time_s: t,
  mode: 'sun_pointing',
  satellite_position_ecef_m: [t, 1, 2],
  power: { battery_soc: 0.5 - t / 1000 },
  uplink: { cumulative_ideal_bits: t },
  downlink: { cumulative_ideal_bits: t * 2 },
});
const session = (patch = {}) => ({
  live_id: 'a',
  initial_scenario: input,
  initial_scenario_id: 's',
  initial_scenario_hash: 'hash',
  samples: [],
  command_acks: [],
  next_sequence: 0,
  first_sequence: 1,
  gap: false,
  final_snapshot: null,
  ...patch,
});
const history = new LiveHistory();
assert.equal(history.snapshot(session()), null);
history.accept(session({ samples: [{ sequence: 1, row: row(0) }], next_sequence: 1 }));
const first = history.snapshot(session());
assert.deepEqual(first.run.result.samples.time_s, [0]);
assert.equal(first.run.status, 'running');
assert.equal(first.run.result.manifest.partial, true);
assert.equal(first.run.result.manifest.history_gap, false);
assert.equal(history.accept(session({ latest_telemetry: row(1), next_sequence: 1 })), true);
assert.equal(history.accept(session({ latest_telemetry: row(1), next_sequence: 1 })), false);
assert.deepEqual(history.snapshot(session()).run.result.samples.time_s, [0, 1]);
assert.deepEqual(
  first.run.result.samples.time_s,
  [0],
  'earlier render snapshots must stay unchanged',
);
history.accept(session({ latest_telemetry: row(2), next_sequence: 1 }));
history.accept(
  session({
    command_acks: [
      { sequence: 2, command: { command_id: 'x', mode: 'imaging', effective_time_s: 2 } },
    ],
    next_sequence: 2,
  }),
);
assert.equal(history.acknowledgments[0].command.command_id, 'x');
history.accept(
  session({
    samples: [{ sequence: 3, row: row(10) }],
    latest_telemetry: row(11),
    next_sequence: 3,
  }),
);
const mixed = history.snapshot(session()).run.result.samples;
assert.deepEqual(mixed.time_s, [0, 1, 2, 10, 11]);
assert.equal(mixed.time_s.length, mixed.power.battery_soc.length);
for (let t = 12; t <= 150; t++)
  history.accept(session({ latest_telemetry: row(t), next_sequence: 3 }));
assert.equal(
  history.snapshot(session()).run.result.samples.time_s.length,
  122,
  'archive rows plus bounded live tail',
);
assert.deepEqual(history.snapshot(session()).run.result.samples.time_s.slice(0, 3), [0, 10, 31]);
assert.throws(
  () => history.accept(session({ samples: [{ sequence: 5, row: row(20) }], next_sequence: 5 })),
  /sequence is incomplete/,
);
const gap = session({
  first_sequence: 8,
  gap: true,
  samples: [{ sequence: 8, row: row(160) }],
  latest_telemetry: row(160),
  next_sequence: 8,
});
history.accept(gap);
assert.equal(history.gap, true);
assert.equal(history.snapshot(gap).run.result.manifest.history_gap, true);
assert.equal(history.sequence, 8);
assert.throws(() => new LiveHistory().accept(session({ next_sequence: 2 })), /watermark skipped/);
const ended = {
  scenario: input,
  run: { run_id: 'final', status: 'complete', result: { samples: { time_s: [0, 10, 12] } } },
};
assert.equal(history.snapshot(session({ final_snapshot: ended })).run, ended.run);
console.log('Live telemetry ordering, gaps, bounded tails and immutable snapshots pass.');

const numeric = new LiveHistory();
const accepted = {
  sequence: 2,
  command: { command_id: 'dt-a', effective_time_s: 2, dynamics_step_s: 0.5 },
};
const rejected = {
  sequence: 3,
  command_id: 'dt-b',
  effective_time_s: 4,
  error: 'Step does not divide the receive window.',
};
const batch = session({
  samples: [
    { sequence: 1, row: row(0) },
    { sequence: 4, row: row(10) },
  ],
  numerical_step_acks: [accepted],
  numerical_step_errors: [rejected],
  next_sequence: 4,
});
numeric.accept(batch);
numeric.accept(batch);
assert.equal(numeric.sequence, 4);
assert.deepEqual(numeric.numericalAcknowledgments, [accepted]);
assert.deepEqual(numeric.numericalErrors, [rejected]);
assert.deepEqual(numeric.snapshot(session()).run.result.samples.time_s, [0, 10]);
assert.deepEqual(numeric.snapshot(session()).run.result.manifest.scenario, input);
console.log(
  'Numerical acknowledgments and rejections share the ordered journal without duplicating samples.',
);
