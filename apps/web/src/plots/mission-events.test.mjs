import assert from 'node:assert/strict';
import { missionEvents } from './missionEvents.ts';

function result(overrides = {}) {
  return {
    manifest: {},
    summary: { ideal_capacity_bits: { uplink: null, downlink: null } },
    samples: { time_s: [0, 10, 20, 30] },
    ...overrides,
  };
}
const modeConfig = {
  uplink: { modes: [{ mode_id: 'q', modulation: 'QPSK', code_rate: '1/2' }] },
  downlink: {
    modes: [
      { mode_id: 'q', modulation: 'QPSK', code_rate: '1/2' },
      { mode_id: 'p', modulation: '8PSK', code_rate: '3/4' },
    ],
  },
};
const receiver = (time_s, state, cause, mode_id = 'q', direction = 'downlink') => ({
  time_s,
  type: 'radio_delivery',
  direction,
  state,
  cause,
  mode_id,
});
const archived = result({
  manifest: { scenario: { radio_delivery: modeConfig } },
  summary: {
    ideal_capacity_bits: { uplink: null, downlink: null },
    reporting: {
      passes: [
        {
          pass_index: 2,
          start_s: 3,
          end_s: 23,
          start_clipped: false,
          end_clipped: true,
          max_elevation_deg: 78,
        },
      ],
    },
  },
  samples: {
    time_s: [0, 10, 20, 30],
    visible: [false, true, true, false],
    mode: ['sun_pointing', 'ground_tracking', 'sun_pointing', 'sun_pointing'],
    power: { sun_visibility: [1, 1, 0, 0] },
  },
  events: [
    {
      time_s: 0,
      type: 'state',
      mode: 'sun_pointing',
      stage_id: 'a',
      visible: false,
      sun_visibility: 1,
    },
    {
      time_s: 3,
      type: 'state',
      mode: 'sun_pointing',
      stage_id: 'a',
      visible: true,
      sun_visibility: 1,
    },
    {
      time_s: 7,
      type: 'state',
      mode: 'ground_tracking',
      stage_id: 'b',
      visible: true,
      sun_visibility: 1,
    },
    receiver(7, 'acquiring', 'radio_scheduled', 'q', 'uplink'),
    receiver(7, 'locked', 'acquisition_complete', 'q', 'uplink'),
    receiver(7.125, 'reconfiguring', 'adaptive_mode_change', 'p'),
    receiver(8.225, 'locked', 'acquisition_complete', 'p'),
    receiver(9.25, 'acquiring', 'hold_threshold_timeout', 'p'),
    {
      time_s: 11,
      type: 'state',
      mode: 'ground_tracking',
      stage_id: 'b',
      visible: true,
      sun_visibility: 0,
    },
    {
      time_s: 15,
      type: 'pointing_command',
      command: {
        command_id: 'pick',
        mode: 'imaging',
        target_latitude_deg: 37.4,
        target_longitude_deg: -122.1,
        effective_time_s: 15,
      },
    },
    {
      time_s: 15,
      type: 'numerical_step',
      command: { command_id: 'step', dynamics_step_s: 0.5, effective_time_s: 15 },
    },
  ],
});
const before = structuredClone(archived);
const normalized = missionEvents(archived);
assert.deepEqual(archived, before, 'Normalization must leave archived science inputs unchanged');
assert.equal(normalized.incomplete, false);
assert.equal(normalized.sampled, false);
assert.equal(
  normalized.events.filter((event) => event.category === 'conops').length,
  1,
  'A visibility or Sun change must not repeat the unchanged CONOPS mode',
);
assert.equal(
  normalized.events.filter((event) => event.category === 'eclipse').length,
  1,
  'Mode changes must not repeat unchanged Sun state',
);
const pass = normalized.events.filter((event) => event.category === 'pass');
assert.equal(pass.length, 1, 'Reporting intervals suppress duplicate visibility markers');
assert.equal(pass[0].time, 3);
assert.equal(pass[0].endTime, 23);
assert.equal(pass[0].label, 'Pass 2');
assert.match(pass[0].detail, /End clipped/);
assert.match(pass[0].detail, /not root-found/);
assert(
  !normalized.events.some((event) => event.time === 0),
  'Initial state is context, not a transition',
);
assert.deepEqual(
  normalized.events.filter((event) => event.time === 7).map((event) => event.label),
  ['CONOPS · ground tracking', 'UL receiver · acquiring', 'UL lock acquired'],
  'Same-time recorded events retain their original causal order',
);
const change = normalized.events.find((event) => event.time === 7.125);
assert.equal(change.label, 'DL MODCOD · 8PSK 3/4');
assert.equal(change.source, 'recorded');
assert.equal(normalized.events.find((event) => event.time === 9.25).label, 'DL lock lost');
assert.deepEqual(
  normalized.events.filter((event) => event.category === 'command').map((event) => event.label),
  ['Command · imaging', 'Integration step · 0.5 s'],
);
assert.match(
  normalized.events.find((event) => event.label === 'Command · imaging').detail,
  /37.4°, -122.1°/,
);
assert.deepEqual(missionEvents(archived), normalized, 'IDs and ordering must be deterministic');
assert.equal(new Set(normalized.events.map((event) => event.id)).size, normalized.events.length);

const initial = missionEvents(
  result({
    events: [
      { type: 'state', time_s: 0, visible: true, mode: 'ground_tracking', sun_visibility: 0 },
      { type: 'state', time_s: 10, visible: false, mode: 'ground_tracking', sun_visibility: 0 },
    ],
  }),
);
assert.deepEqual(
  initial.events.map((event) => event.label),
  ['Station mask exit'],
);

const live = result({
  manifest: {
    partial: true,
    kind: 'live_telemetry_prefix',
    scenario: { radio_delivery: modeConfig },
  },
  samples: {
    time_s: [100, 110, 120, 130],
    visible: [true, true, false, false],
    power: { sun_visibility: [0, 0, 1, 1] },
    mode: ['ground_tracking', 'ground_tracking', 'sun_pointing', 'sun_pointing'],
    gnc: { wheel_saturated: [true, true, false, true] },
    radio_delivery: {
      downlink: {
        receiver_state: ['locked', 'reconfiguring', 'acquiring', 'locked'],
        mode_id: ['q', 'q', 'p', 'p'],
      },
    },
  },
});
const sampled = missionEvents(live);
assert.equal(
  sampled.incomplete,
  false,
  'Missing live log/report does not imply a known omitted event',
);
assert.equal(
  missionEvents({ ...live, manifest: { ...live.manifest, history_gap: true } }).incomplete,
  true,
  'Presentation metadata preserves a known live history gap',
);
assert.equal(sampled.sampled, true);
assert(
  sampled.events.every(
    (event) => event.source === 'sampled' && event.time > 100 && event.time <= 130,
  ),
);
assert(sampled.events.every((event) => /sampled/.test(event.label)));
assert(sampled.events.every((event) => /between returned samples/.test(event.detail)));
const wheels = sampled.events.filter((event) => event.category === 'wheel');
assert.deepEqual(
  wheels.map((event) => event.time),
  [120, 130],
);
assert.match(wheels[0].detail, /torque, speed or power/);
assert.match(wheels[0].detail, /does not identify momentum saturation/);
assert.match(
  sampled.events.find((event) => event.time === 120 && event.category === 'radio').label,
  /8PSK 3\/4/,
);
assert(
  !sampled.events.some((event) => event.label.includes('lock lost')),
  'Samples do not establish a receiver dropout cause',
);

const unknown = missionEvents(
  result({
    samples: {
      time_s: [0, 1, 2, 3],
      visible: [null, true, null, false],
      power: { sun_visibility: [0, null, 1, 0] },
      gnc: { wheel_saturated: [false, null, true, false] },
      radio_delivery: {
        downlink: {
          receiver_state: ['locked', null, 'locked', 'acquiring'],
          mode_id: ['q', null, 'p', 'p'],
        },
      },
    },
  }),
);
assert(
  unknown.events.every((event) => event.time === 3),
  'Unknown values must break comparisons',
);
assert.equal(unknown.events.filter((event) => event.category === 'pass').length, 0);
assert(!unknown.events.some((event) => event.label.includes('MODCOD')));
const invalidTime = missionEvents(
  result({
    samples: {
      time_s: [0, null, 2, 1, 4],
      gnc: { wheel_saturated: [false, true, false, true, false] },
    },
  }),
);
assert.deepEqual(
  invalidTime.events.map((event) => event.time),
  [4],
  'Invalid or non-increasing adjacent sample times do not establish a bracket',
);
assert.deepEqual(missionEvents(result({ samples: {} })).events, []);

const recordedContext = result({
  samples: live.samples,
  events: [
    { type: 'state', time_s: 100, visible: true, mode: 'ground_tracking', sun_visibility: 0 },
    receiver(100, 'locked', 'acquisition_complete'),
  ],
});
const contextEvents = missionEvents(recordedContext).events;
assert(
  contextEvents
    .filter((event) => event.source === 'sampled')
    .every((event) => event.category === 'wheel'),
  'Recorded category streams suppress sampled duplicates, even if only their context is present',
);

const log = [
  receiver(1, 'reconfiguring', 'adaptive_mode_change'),
  receiver(2, 'locked', 'acquisition_complete'),
];
assert.equal(
  missionEvents(
    result({
      events: log,
      manifest: {
        radio_delivery: {
          events_dropped: 0,
          event_export: { maximum_receiver_events: 2, exported_receiver_events: 2 },
        },
      },
    }),
  ).incomplete,
  false,
  'An exactly full log is complete when the exporter explicitly reports zero omissions',
);
for (const metadata of [
  { events_dropped: 1 },
  { event_export: { maximum_receiver_events: 2, exported_receiver_events: 2 } },
  { event_export: { maximum_receiver_events: 20000, exported_receiver_events: 3 } },
])
  assert.equal(
    missionEvents(result({ events: log, manifest: { radio_delivery: metadata } })).incomplete,
    true,
  );
assert.equal(
  missionEvents(
    result({
      events: log,
      manifest: {
        radio_delivery: {
          events_dropped: 0,
          event_export: {
            maximum_receiver_events: 20000,
            exported_receiver_events: 2,
            outside_computed_prefix: 3,
          },
        },
      },
    }),
  ).incomplete,
  false,
  'Expected removal outside the computed prefix is not an in-range omission',
);
assert.equal(
  missionEvents(
    result({ events: log, summary: { radio_delivery: { downlink: { mode_change_count: 2 } } } }),
  ).incomplete,
  true,
  'Counter evidence can reveal an unlogged switch during reconfiguration',
);
assert.equal(
  missionEvents(result({ events: [receiver(Number.NaN, 'locked', 'acquisition_complete')] }))
    .incomplete,
  true,
);

const prefix = missionEvents(
  result({
    manifest: { partial: true },
    samples: { time_s: [100, 110, 120] },
    events: [
      receiver(90, 'acquiring', 'channel_available'),
      receiver(105.5, 'locked', 'acquisition_complete'),
      receiver(121, 'acquiring', 'hold_threshold_timeout'),
    ],
    summary: {
      reporting: {
        passes: [
          { pass_index: 1, start_s: 0, end_s: 500, start_clipped: false, end_clipped: false },
        ],
      },
    },
  }),
);
assert.deepEqual(
  prefix.events.map((event) => event.time),
  [100, 105.5],
);
assert.equal(prefix.events[0].endTime, 120);
assert.match(prefix.events[0].detail, /Start clipped/);
assert.match(prefix.events[0].detail, /End clipped/);
assert.equal(prefix.incomplete, false);
assert.deepEqual(
  missionEvents(result({ manifest: { partial: true }, samples: { time_s: [] }, events: log }))
    .events,
  [],
);
const legacy = missionEvents(
  result({
    events: [
      {
        time_s: 10,
        kind: 'visible',
        value: true,
        timing: 'first sample after transition; grid resolved',
      },
      {
        time_s: 10,
        kind: 'active_direction',
        value: 'downlink',
        timing: 'first sample after transition; grid resolved',
      },
    ],
    samples: { time_s: [0, 10], visible: [false, true], active_direction: ['uplink', 'downlink'] },
  }),
);
assert.deepEqual(
  legacy.events.map((event) => event.label),
  ['Station mask entry', 'DL window'],
);
assert(
  legacy.events.every(
    (event) => event.source === 'recorded' && /first output sample/.test(event.detail),
  ),
);

const manyTimes = Array.from({ length: 200000 }, (_, index) => index);
assert.doesNotThrow(
  () => missionEvents(result({ manifest: { partial: true }, samples: { time_s: manyTimes } })),
  'Large histories must not spread samples into function arguments',
);
console.log(
  'Mission events passed: recorded state-field changes, clipped passes, fractional receiver/command events, stable ties and IDs, live sampled brackets, unknown/initial states, prefix bounds, caps/omissions and immutable archives.',
);
