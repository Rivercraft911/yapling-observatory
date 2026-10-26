import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function moduleUrl(name, dependencies = {}) {
  let compiled = ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  for (const [path, url] of Object.entries(dependencies))
    compiled = compiled.replaceAll(`from '${path}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const geodesy = await moduleUrl('./geodesy.ts');
const groundTrack = await moduleUrl('./groundTrack.ts', {
  '../mission/contactState': await moduleUrl('../mission/contactState.ts'),
  './geodesy': geodesy,
});
const { buildGroundTrack } = await import(groundTrack);
const {
  FLAT_MAP_WIDTH: W,
  FLAT_MAP_HEIGHT: H,
  WORLD_MAP_VIEW,
  geographicToMap,
  displayGroundPointToMap,
  ecefToFlatMap,
  splitMapSegment,
  splitMapPolyline,
  mapPolylinePath,
  coverageBoundaryPath,
  flatTrackPaths,
  flatMapViewport,
  constrainFlatMapView,
  zoomFlatMapView,
  panFlatMapView,
  defaultCoverageModes,
  MAX_FLAT_TRACK_SEGMENTS,
  MAX_FLAT_RF_SAMPLES_PER_DIRECTION,
} = await import(
  await moduleUrl('./flatMapGeometry.ts', { './groundTrack': groundTrack, './geodesy': geodesy })
);
const { geodeticToEcef, WGS84_A_M: A, WGS84_B_OVER_A: B } = await import(geodesy);
const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);
const location = (latitude_deg, longitude_deg) => geographicToMap({ latitude_deg, longitude_deg });
assert.deepEqual(location(0, 0), { x: W / 2, y: H / 2 });
assert.deepEqual(location(90, -180), { x: 0, y: 0 });
assert.deepEqual(location(-90, 180), { x: W, y: H });
assert.deepEqual(location(0, 181), location(0, -179));
assert.deepEqual(location(0, -181), location(0, 179));
for (const invalid of [
  null,
  undefined,
  {},
  { latitude_deg: 91, longitude_deg: 0 },
  { latitude_deg: 0, longitude_deg: NaN },
  { latitude_deg: Infinity, longitude_deg: 0 },
])
  assert.equal(geographicToMap(invalid), null);
for (const invalid of [null, undefined, [], [0, 0, 0], [1, 2], [NaN, 0, 0]])
  assert.equal(displayGroundPointToMap(invalid), null);
assert.equal(ecefToFlatMap([1, 2, 3]), null);
assert.deepEqual(displayGroundPointToMap([1, 0, 0]), location(0, 0));
assert.deepEqual(displayGroundPointToMap([0, B, 0]), location(90, 0));
assert.deepEqual(displayGroundPointToMap([0, 0, -1]), location(0, 90));
const stanfordSurface = ecefToFlatMap(geodeticToEcef(37.426, -122.173, 0));
close(stanfordSurface.x, location(37.426, -122.173).x);
close(stanfordSurface.y, location(37.426, -122.173).y);

// Dateline clipping is display interpolation. No edge-spanning chord is drawn.
for (const [a, b, expected] of [
  [
    location(10, 170),
    location(30, -170),
    [
      [
        { x: 1400, y: 320 },
        { x: 1440, y: 280 },
      ],
      [
        { x: 0, y: 280 },
        { x: 40, y: 240 },
      ],
    ],
  ],
  [
    location(30, -170),
    location(10, 170),
    [
      [
        { x: 40, y: 240 },
        { x: 0, y: 280 },
      ],
      [
        { x: 1440, y: 280 },
        { x: 1400, y: 320 },
      ],
    ],
  ],
])
  assert.deepEqual(splitMapSegment(a, b), expected);
assert.equal(splitMapSegment(location(0, 179), location(0, -179)).length, 2);
assert.equal(splitMapSegment(location(0, 180), location(0, -180)).length, 0);
assert.ok(
  splitMapSegment(location(10, 180), location(20, -180)).every((points) =>
    points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  ),
);
assert.deepEqual(splitMapSegment(location(0, 0), location(0, 1)), [
  [location(0, 0), location(0, 1)],
]);
assert.deepEqual(splitMapSegment({ x: NaN, y: 0 }, location(0, 0)), []);
const ring = [location(10, 170), location(10, -170), location(-10, -170), location(-10, 170)];
const clipped = splitMapPolyline(ring, true);
for (const path of clipped)
  for (let index = 1; index < path.length; index++)
    assert.ok(Math.abs(path[index].x - path[index - 1].x) <= W / 2);
const simpleRing = [location(0, 0), location(5, 10), location(-5, 10)];
const closed = splitMapPolyline(simpleRing, true);
assert.deepEqual(closed[0][0], closed[0].at(-1));
assert.equal(
  mapPolylinePath(closed[0]).includes('Z'),
  false,
  'No implicit polygon fill closure crosses a seam',
);
const broken = splitMapPolyline(
  [location(0, 0), location(0, 1), null, location(0, 3), location(0, 4)],
  true,
);
assert.equal(broken.length, 2);
assert.equal(broken[0].length, 2);
assert.equal(broken[1].length, 2, 'Invalid boundary rows do not become artificial closing lines');
assert.equal(
  coverageBoundaryPath([
    { latitude_deg: 0, longitude_deg: 0 },
    { latitude_deg: 1, longitude_deg: 2 },
    { latitude_deg: 2, longitude_deg: 0 },
  ]),
  'M720,360L728,356L720,352L720,360',
);

const samples = (longitudes, times = longitudes.map((_, index) => index)) => ({
  time_s: times,
  satellite_position_ecef_m: longitudes.map((longitude) => [
    (A + 550000) * Math.cos((longitude * Math.PI) / 180),
    (A + 550000) * Math.sin((longitude * Math.PI) / 180),
    0,
  ]),
  visible: longitudes.map(() => true),
  elevation_deg: longitudes.map(() => 40),
  range_m: longitudes.map(() => 800000),
  radio_active: longitudes.map(() => true),
  active_direction: longitudes.map((_, index) => (index % 2 ? 'uplink' : 'downlink')),
  uplink: { margin_db: longitudes.map(() => 4) },
  downlink: { margin_db: longitudes.map(() => 4) },
});
const input = samples([170, 179, -179, -170, -160], [0, 1, 2, 100, 101]);
const immutable = structuredClone(input);
const selected = buildGroundTrack(input, { cursorTimeS: 50, windowSeconds: Infinity, maxGapS: 2 });
const display = flatTrackPaths(selected);
assert.equal(
  (display.orbit.match(/M/g) ?? []).length,
  4,
  'One clipped seam adds one subpath; the actual time gap stays open',
);
assert.equal(display.totalSegmentCount, 3);
assert.equal(display.renderedSegmentCount, 3);
assert.equal((display.uplink.match(/M/g) ?? []).length, 2);
assert.equal((display.downlink.match(/M/g) ?? []).length, 3);
assert.ok(
  !display.uplink.includes('L') && !display.downlink.includes('L'),
  'RF samples remain independent dots',
);
assert.equal(display.thinned, false);
assert.deepEqual(input, immutable);
input.satellite_position_ecef_m[1] = null;
const invalidRowTrack = buildGroundTrack(input, {
  cursorTimeS: 50,
  windowSeconds: Infinity,
  maxGapS: 2,
});
assert.equal(flatTrackPaths(invalidRowTrack).renderedSegmentCount, 1);
assert.equal(flatTrackPaths(null).orbit, '');
const malformed = structuredClone(selected);
malformed.segments[0].end.index = 88;
assert.equal(flatTrackPaths(malformed).renderedSegmentCount, 1);

// Large histories are a bounded selection of original pairs, never a new sparse polyline.
const longInput = samples(Array.from({ length: 30001 }, (_, index) => (index % 300) - 150));
const longTrack = buildGroundTrack(longInput, { cursorTimeS: 0, windowSeconds: Infinity });
const longDisplay = flatTrackPaths(longTrack);
assert.ok(longDisplay.selectedSegmentCount <= MAX_FLAT_TRACK_SEGMENTS);
assert.ok(longDisplay.selectedRfSampleCount <= MAX_FLAT_RF_SAMPLES_PER_DIRECTION * 2);
assert.equal(longDisplay.thinned, true);
assert.ok((longDisplay.orbit.match(/M/g) ?? []).length >= longDisplay.renderedSegmentCount);
assert.ok((longDisplay.orbit.match(/M/g) ?? []).length <= longDisplay.renderedSegmentCount * 2);
assert.ok(longDisplay.contact.length > 0);

for (const size of [
  { width: 1200, height: 500 },
  { width: 500, height: 1000 },
  { width: 1600, height: 400 },
]) {
  const viewport = flatMapViewport(size, WORLD_MAP_VIEW);
  close(viewport.width / viewport.height, size.width / size.height);
  assert.ok(
    viewport.width >= W && viewport.height >= H,
    'World is fully contained on any pane aspect ratio',
  );
  const focused = constrainFlatMapView(size, { center: location(37.426, -122.173), zoom: 5 });
  const zoomed = zoomFlatMapView(size, focused, 7, { x: 0.7, y: 0.6 });
  const before = flatMapViewport(size, focused),
    after = flatMapViewport(size, zoomed);
  close(before.x + before.width * 0.7, after.x + after.width * 0.7);
  close(before.y + before.height * 0.6, after.y + after.height * 0.6);
  assert.deepEqual(panFlatMapView(size, focused, { x: 0, y: 0 }), focused);
}
assert.equal(
  constrainFlatMapView({ width: 1200, height: 600 }, { center: { x: -200, y: -500 }, zoom: 100 })
    .zoom,
  24,
);
const wrapped = panFlatMapView(
  { width: 1200, height: 600 },
  { center: { x: 1, y: 360 }, zoom: 5 },
  { x: 20, y: 0 },
);
assert.ok(wrapped.center.x > 1400);
assert.deepEqual(
  defaultCoverageModes([
    { mode_id: 'other', modulation: 'QPSK', code_rate: '1/4' },
    { mode_id: 'half', modulation: 'QPSK', code_rate: '1/2' },
    { mode_id: 'three-quarter', modulation: 'QPSK', code_rate: '3/4' },
    { mode_id: 'two-third', modulation: '8PSK', code_rate: '2/3' },
    { mode_id: 'eight-ninth', modulation: '8PSK', code_rate: '8/9' },
    { mode_id: 'nine-tenth', modulation: '8PSK', code_rate: '9/10' },
  ]),
  ['half', 'two-third', 'eight-ninth', 'nine-tenth'],
);
console.log(
  'Flat map passed: cartographic mapping, poles and world edges; exact dateline clipping; closed and damaged boundary handling; returned sample/state selection, gaps and invalid rows; independent RF dots; immutable 30k-row bounded display; aspect-preserving fit, pointer-anchored zoom, pan and wrapping. No RF or propagation equations.',
);
