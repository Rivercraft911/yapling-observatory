import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { WGS84_A_M, WGS84_B_OVER_A } from './geodesy.ts';

async function moduleUrl(name, dependencies = {}) {
  let compiled = ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const [path, url] of Object.entries(dependencies))
    compiled = compiled.replace(`from '${path}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const { contactStateAtSample } = await import(await moduleUrl('../mission/contactState.ts'));
const {
  buildGroundTrack,
  projectGroundTrackPosition,
  selectGroundTrackMarkers,
  groundTrackWindowBounds,
} = await import(
  await moduleUrl('./groundTrack.ts', {
    '../mission/contactState': await moduleUrl('../mission/contactState.ts'),
    './geodesy': new URL('./geodesy.ts', import.meta.url).href,
  })
);
const a = WGS84_A_M;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12);
const sample = (times) => ({
  time_s: times,
  satellite_position_ecef_m: times.map((_, i) => [a + 550000, i * 1000, 0]),
  visible: times.map(() => true),
  elevation_deg: times.map(() => 25),
  range_m: times.map((_, i) => 900000 + i * 100),
  radio_active: times.map(() => true),
  active_direction: times.map(() => 'uplink'),
  uplink: { margin_db: times.map(() => 9) },
  downlink: { margin_db: times.map(() => 4) },
});
const all = { cursorTimeS: 0, windowSeconds: Infinity };

for (const [position, expected] of [
  [
    [a + 550000, 0, 0],
    [1, 0, 0],
  ],
  [
    [0, a + 550000, 0],
    [0, 0, -1],
  ],
  [
    [0, 0, a + 550000],
    [0, WGS84_B_OVER_A, 0],
  ],
])
  projectGroundTrackPosition(position).forEach((value, index) => near(value, expected[index]));
const sourcePosition = [2 * a, 0, 2 * a];
const projected = projectGroundTrackPosition(sourcePosition);
near(projected[0] ** 2 + (projected[1] / WGS84_B_OVER_A) ** 2 + projected[2] ** 2, 1);
near(projected[0] / projected[1], 1);
assert.deepEqual(sourcePosition, [2 * a, 0, 2 * a]);
for (const invalid of [null, undefined, [], [0, 0, 0], [1, 2, 3], [NaN, a, 0], [Infinity, 0, 0]])
  assert.equal(projectGroundTrackPosition(invalid), null);

// Visibility, scheduling and threshold availability are separate returned states.
const states = sample(Array.from({ length: 12 }, (_, i) => i));
states.visible = [false, true, true, true, true, true, true, undefined, true, true, true, true];
states.elevation_deg = [-2, 0, 20, 25, 25, 25, 25, 25, -0.1, NaN, 25, 25];
states.radio_active = [
  true,
  true,
  true,
  false,
  undefined,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
states.active_direction[2] = 'downlink';
states.active_direction[11] = 'invalid';
states.uplink.margin_db = [9, 0, 9, 9, 9, -1, null, 9, 9, 9, NaN, 9];
assert.deepEqual(
  states.time_s.map((_, i) => contactStateAtSample(states, i).state),
  [
    'below-mask',
    'uplink',
    'downlink',
    'radio-idle',
    'radio-unknown',
    'below-threshold',
    'rf-unresolved',
    'geometry-unavailable',
    'geometry-unavailable',
    'geometry-unavailable',
    'rf-unresolved',
    'radio-unknown',
  ],
);
assert.equal(contactStateAtSample(states, 1).marginSource, 'reference-profile');
assert.equal(contactStateAtSample(states, 100).state, 'geometry-unavailable');
assert.equal(contactStateAtSample({ ...states, elevation_deg: [] }, 1).visibility, 'unknown');
assert.equal(
  contactStateAtSample({ ...states, radio_active: undefined }, 1).state,
  'radio-unknown',
);

const adaptive = sample([0, 10, 20, 30, 40]);
adaptive.radio_delivery = {
  uplink: {
    selected_margin_db: [null, -3, 0, 2, NaN],
    locked: [true, true, false, true, true],
    ready_payload_rate_bps: [100, 100, 0, 100, 100],
    delivered_useful_bits: [0, 1, 2, 3, 4],
  },
};
assert.deepEqual(
  adaptive.time_s.map((_, i) => contactStateAtSample(adaptive, i).state),
  ['rf-unresolved', 'below-threshold', 'uplink', 'uplink', 'rf-unresolved'],
);
assert.equal(contactStateAtSample(adaptive, 1).marginDb, -3);
assert.equal(contactStateAtSample(adaptive, 1).marginSource, 'selected-mode');
for (const receiver of [{}, { receiver_state: ['locked'] }, { selected_margin_db: undefined }]) {
  const state = contactStateAtSample({ ...adaptive, radio_delivery: { uplink: receiver } }, 0);
  assert.equal(state.state, 'rf-unresolved');
  assert.equal(state.marginDb, null);
}
assert.equal(
  contactStateAtSample(
    { ...adaptive, active_direction: ['downlink'], radio_delivery: { uplink: {} } },
    0,
  ).state,
  'rf-unresolved',
);
adaptive.visible[3] = false;
assert.equal(contactStateAtSample(adaptive, 3).state, 'below-mask');
adaptive.visible[3] = true;
adaptive.radio_active[3] = false;
assert.equal(contactStateAtSample(adaptive, 3).state, 'radio-idle');

// AOS/LOS are observed sample brackets. Extrema retain the returned sample and units.
const passes = sample([0, 10, 20, 30, 40, 50, 60, 70]);
passes.visible = [false, true, true, false, false, true, true, false];
passes.elevation_deg = [5, 20, 45, 5, 5, 50, 25, 5];
passes.range_m = [9e6, 6e5, 7e5, 9e6, 9e6, 7e5, 5e5, 9e6];
passes.radio_active[1] = false;
const saved = structuredClone(passes);
const track = buildGroundTrack(passes, all);
assert.equal(track.projection, 'radial-wgs84-display');
assert.equal(track.contacts.length, 2);
assert.equal(track.points.length, 8);
assert.equal(track.segments.length, 7);
assert.equal(track.points[1].state, 'radio-idle');
assert.deepEqual(
  track.contacts.map(({ start, end, startClipped, endClipped }) => [
    start.index,
    end.index,
    startClipped,
    endClipped,
  ]),
  [
    [1, 2, false, false],
    [5, 6, false, false],
  ],
);
assert.deepEqual(
  track.markers.map(({ kind, point, bracketStartS, bracketEndS }) => [
    kind,
    point.index,
    bracketStartS,
    bracketEndS,
  ]),
  [
    ['aos', 1, 0, 10],
    ['closest', 1, undefined, undefined],
    ['highest', 2, undefined, undefined],
    ['los', 2, 20, 30],
    ['aos', 5, 40, 50],
    ['highest', 5, undefined, undefined],
    ['closest', 6, undefined, undefined],
    ['los', 6, 60, 70],
  ],
);
assert.equal(track.segments[0].visibility, 'below-mask');
assert.equal(track.segments[1].visibility, 'visible');
assert.equal(track.segments[1].state, 'transition');
assert.deepEqual(passes, saved);

const partial = buildGroundTrack(passes, { ...all, availableThroughTimeS: 25 });
assert.deepEqual(
  partial.points.map((point) => point.timeS),
  [0, 10, 20],
);
assert.equal(partial.contacts.length, 1);
assert.equal(partial.contacts[0].endClipped, true);
assert.equal(
  partial.markers.some((marker) => marker.kind === 'los'),
  false,
);
assert.equal(
  partial.markers.some((marker) => marker.point.timeS > 25),
  false,
);
const clipped = buildGroundTrack(passes, { cursorTimeS: 20, windowSeconds: 20 });
assert.equal(clipped.contacts[0].startClipped, true);
assert.equal(
  clipped.markers.some((marker) => marker.kind === 'aos'),
  false,
);
assert.equal(clipped.markers.find((marker) => marker.kind === 'los').point.index, 2);
const boundary = buildGroundTrack(sample([0, 10]), all);
assert.equal(boundary.contacts[0].startClipped, true);
assert.equal(boundary.contacts[0].endClipped, true);
assert.deepEqual(boundary.markers.map((marker) => marker.kind).sort(), ['closest', 'highest']);

// Explicit drawing gaps, invalid rows and nonmonotonic time do not get bridged.
const gaps = sample([0, 10, 20, 100, 110]);
gaps.visible = [false, true, true, true, false];
const gapTrack = buildGroundTrack(gaps, { ...all, maxGapS: 30 });
assert.deepEqual(
  gapTrack.segments.map(({ start, end }) => [start.index, end.index]),
  [
    [0, 1],
    [1, 2],
    [3, 4],
  ],
);
assert.deepEqual(
  gapTrack.contacts.map((contact) => [contact.startClipped, contact.endClipped]),
  [
    [false, true],
    [true, false],
  ],
);
assert.equal(buildGroundTrack(gaps, all).contacts.length, 1);
for (const invalid of [null, [NaN, 0, 0], [0, 0, 0], [1, 2]]) {
  const broken = structuredClone(passes);
  broken.satellite_position_ecef_m[2] = invalid;
  const data = buildGroundTrack(broken, all);
  assert.equal(
    data.points.some((point) => point.index === 2),
    false,
  );
  assert.equal(
    data.segments.some(({ start, end }) => start.index < 2 && end.index > 2),
    false,
  );
  assert.equal(
    data.markers.some(({ kind, point }) => kind === 'los' && point.index === 1),
    false,
  );
}
const backwards = buildGroundTrack(sample([0, 10, 5, 20]), all);
assert.equal(
  backwards.segments.some(({ start, end }) => end.timeS <= start.timeS),
  false,
);
const missingTime = buildGroundTrack(sample([0, NaN, 20]), all);
assert.equal(missingTime.segments.length, 0);

const long = sample(Array.from({ length: 11 }, (_, i) => 3600 * i));
assert.deepEqual(
  buildGroundTrack(long, { cursorTimeS: 18000 }).points.map((point) => point.timeS),
  [14400, 18000, 21600],
);
assert.equal(
  buildGroundTrack(long, { cursorTimeS: 18000, windowSeconds: 86400 }).points.length,
  11,
);
assert.equal(buildGroundTrack(long, all).points.length, 11);
assert.equal(buildGroundTrack(sample([]), all).points.length, 0);
assert.deepEqual(groundTrackWindowBounds(long.time_s, 18000), {
  startIndex: 4,
  endIndex: 6,
  windowStartS: 12600,
  windowEndS: 23400,
  availableThroughTimeS: 36000,
});
assert.deepEqual(
  ['startIndex', 'endIndex'].map((key) => groundTrackWindowBounds([], 0)[key]),
  [-1, -1],
);
assert.deepEqual(
  groundTrackWindowBounds(
    Array.from({ length: 200000 }, (_, i) => i),
    100000,
  ),
  {
    startIndex: 94600,
    endIndex: 105400,
    windowStartS: 94600,
    windowEndS: 105400,
    availableThroughTimeS: 199999,
  },
);

// Two returned revolutions stay distinct; longitude wrapping requires no path inference.
const revolutions = sample(Array.from({ length: 25 }, (_, i) => i * 600));
revolutions.satellite_position_ecef_m = revolutions.time_s.map((_, i) => {
  const angle = (i * Math.PI) / 6;
  return [(a + 550000) * Math.cos(angle), (a + 550000) * Math.sin(angle), 0];
});
const twoOrbits = buildGroundTrack(revolutions, { cursorTimeS: 7200, windowSeconds: Infinity });
assert.equal(twoOrbits.points.length, 25);
assert.equal(twoOrbits.segments.length, 24);
assert.equal(twoOrbits.points[0].index, 0);
assert.equal(twoOrbits.points[12].index, 12);
near(twoOrbits.points[0].position[0], twoOrbits.points[12].position[0]);
assert.ok(
  twoOrbits.segments.every(
    ({ start, end }) =>
      Math.hypot(...end.position.map((value, i) => value - start.position[i])) < 0.6,
  ),
);

const manyPasses = sample(Array.from({ length: 400 }, (_, i) => i));
manyPasses.visible = manyPasses.time_s.map((i) => i % 4 === 1 || i % 4 === 2);
const crowded = buildGroundTrack(manyPasses, { cursorTimeS: 200, windowSeconds: Infinity });
assert.equal(crowded.contacts.length, 100);
assert.equal(crowded.markers.length, 64);
assert.equal(crowded.omittedMarkerCount, 336);
assert.ok(crowded.markers.every(({ point }) => point.timeS > 160 && point.timeS < 240));
assert.equal(buildGroundTrack(manyPasses, { ...all, maxMarkers: 0 }).markers.length, 0);
const candidatesBefore = [...crowded.candidateMarkers];
const laterMarkers = selectGroundTrackMarkers(crowded.candidateMarkers, 350);
assert.equal(laterMarkers.markers.length, 64);
assert.equal(laterMarkers.omittedMarkerCount, 336);
assert.ok(laterMarkers.markers.every(({ point }) => point.timeS > 310 && point.timeS < 390));
assert.deepEqual(crowded.candidateMarkers, candidatesBefore);

console.log(
  'Ground track passed: immutable radial WGS84 display projection, independent mask/radio/RF states, adaptive selected margins, unresolved fixed/scheduled receiver modes, sampled transition brackets/extrema, clipped live/window edges, explicit display gaps, invalid rows, two revolutions, bounded windows and marker limits. No propagation, contact interpolation or delivery inference.',
);
