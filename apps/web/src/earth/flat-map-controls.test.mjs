import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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
  './geodesy': geodesy,
  '../mission/contactState': await moduleUrl('../mission/contactState.ts'),
});
const helpers = await import(
  await moduleUrl('./flatMapGeometry.ts', { './geodesy': geodesy, './groundTrack': groundTrack })
);
const { buildGroundTrack } = await import(groundTrack);
const { geodeticToEcef } = await import(geodesy);
const slots = [];
let cursor = 0,
  effects = [],
  pathBuilds = 0;
const listeners = new Map();
const captured = new Set();
const rectangle = { x: 0, y: 0, left: 0, top: 0, width: 960, height: 540 };
const element = {
  dataset: {},
  getBoundingClientRect: () => rectangle,
  focus() {},
  setPointerCapture(id) {
    captured.add(id);
  },
  hasPointerCapture: (id) => captured.has(id),
  releasePointerCapture(id) {
    captured.delete(id);
  },
  addEventListener(name, handler) {
    listeners.set(name, handler);
  },
  removeEventListener(name) {
    listeners.delete(name);
  },
};
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useId() {
    const index = cursor++;
    return `map-${index}`;
  },
  useMemo(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i])))
      slots[index] = { dependencies, value: setup() };
    return slots[index].value;
  },
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i])))
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
  },
};
const jsx = (type, props) => {
  if (typeof type === 'string' && props.ref && !props.ref.current) props.ref.current = element;
  return { type, props };
};
const source = await readFile(new URL('./FlatGroundTrack.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === './flatMapGeometry')
      return {
        ...helpers,
        flatTrackPaths(track) {
          pathBuilds++;
          return helpers.flatTrackPaths(track);
        },
      };
    if (name === './flat-ground-track.css') return {};
    throw new Error(`Unexpected import ${name}`);
  },
});
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text(node.props?.children)
      : node == null || typeof node === 'boolean'
        ? ''
        : String(node);
const find = (node, predicate) =>
  Array.isArray(node)
    ? node.map((child) => find(child, predicate)).find(Boolean)
    : !node || typeof node !== 'object'
      ? undefined
      : predicate(node)
        ? node
        : find(node.props?.children, predicate);
const button = (tree, label) =>
  find(tree, (node) => node.type === 'button' && text(node) === label);
const map = (tree) => find(tree, (node) => node.type === 'svg');
const mapWidth = (tree) => +map(tree).props.viewBox.split(' ')[2];
const samples = {
  time_s: [0, 1, 2],
  satellite_position_ecef_m: [
    geodeticToEcef(35, -125, 550000),
    geodeticToEcef(37, -122, 550000),
    geodeticToEcef(40, -120, 550000),
  ],
  visible: [true, true, true],
  elevation_deg: [20, 80, 25],
  range_m: [900000, 550000, 850000],
  radio_active: [true, true, true],
  active_direction: ['uplink', 'downlink', 'uplink'],
  uplink: { margin_db: [2, 2, 2] },
  downlink: { margin_db: [4, 4, 4] },
};
const contour = (mode_id, modulation, code_rate) => ({
  mode_id,
  label: `${modulation} ${code_rate}`,
  modulation,
  code_rate,
  symbol_rate_sps: 5000000,
  threshold_esn0_db: 1.25,
  threshold_status: 'ideal reference',
  threshold_source: 'independent reference',
  engineering_reserve_db: null,
  threshold_includes_reserve: true,
  status: 'coverage',
  limit: 'elevation_mask',
  max_slant_range_m: 1500000,
  boundary: [
    { latitude_deg: 35, longitude_deg: -125 },
    { latitude_deg: 40, longitude_deg: -120 },
    { latitude_deg: 35, longitude_deg: -115 },
    { latitude_deg: 35, longitude_deg: -125 },
  ],
});
const coverage = {
  schema_version: '0.1.0',
  model: 'conditional_peak_gain_coverage_v1',
  display_projection: 'radial_wgs84_surface_geodetic',
  scenario_sha256: 'test',
  direction: 'downlink',
  altitude_m: 550000,
  altitude_source: 'nominal_orbit_planning_height',
  station: { latitude_deg: 37, longitude_deg: -122, height_m: 0, minimum_elevation_deg: 10 },
  mode_source: 'configured_receiver',
  assumptions: ['Constant peak gain; assumed polarization loss.'],
  contours: [
    contour('half', 'QPSK', '1/2'),
    contour('three-quarter', 'QPSK', '3/4'),
    contour('two-third', '8PSK', '2/3'),
    contour('eight-ninth', '8PSK', '8/9'),
    contour('nine-tenth', '8PSK', '9/10'),
  ],
};
let props = {
  track: buildGroundTrack(samples, { cursorTimeS: 1, windowSeconds: Infinity }),
  currentPositionEcefM: samples.satellite_position_ecef_m[1],
  station: { latitudeDeg: 37, longitudeDeg: -122, label: 'Durand' },
  coverage,
  coverageState: 'ready',
};
const saved = JSON.stringify(props);
const render = () => {
  cursor = 0;
  effects = [];
  const tree = exports.FlatGroundTrack(props);
  for (const effect of effects) effect();
  return tree;
};
let tree = render();
const worldWidth = mapWidth(tree);
assert.equal(map(tree).props.role, 'application');
assert.equal(map(tree).props.tabIndex, 0);
assert.ok(map(tree).props['aria-label'].includes('Arrow keys'));
assert.equal(
  find(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Zoom map out').props
    .disabled,
  true,
);
button(tree, 'Durand').props.onClick();
tree = render();
assert.ok(mapWidth(tree) < worldWidth / 4);
assert.equal(pathBuilds, 1);
button(tree, '+').props.onClick();
tree = render();
assert.ok(mapWidth(tree) < worldWidth / 6);
let prevented = false;
map(tree).props.onKeyDown({
  key: 'Home',
  preventDefault() {
    prevented = true;
  },
  stopPropagation() {},
});
tree = render();
assert.equal(prevented, true);
assert.equal(mapWidth(tree), worldWidth);
listeners.get('wheel')({
  deltaY: -200,
  deltaMode: 0,
  clientX: 480,
  clientY: 270,
  preventDefault() {},
});
tree = render();
assert.ok(mapWidth(tree) < worldWidth);
const beforePan = map(tree).props.viewBox;
const pointer = (x, y) => ({
  button: 0,
  pointerId: 1,
  clientX: x,
  clientY: y,
  currentTarget: element,
});
map(tree).props.onPointerDown(pointer(400, 250));
map(tree).props.onPointerMove(pointer(450, 250));
tree = render();
assert.notEqual(map(tree).props.viewBox, beforePan);
map(tree).props.onPointerUp(pointer(450, 250));
assert.equal(captured.size, 0);
button(tree, 'MODCOD +').props.onClick();
tree = render();
const menu = find(tree, (node) => node.props.role === 'group');
assert.ok(menu);
const threeQuarter = button(menu, 'QPSK 3/4');
assert.equal(threeQuarter.props['aria-pressed'], false);
threeQuarter.props.onClick();
tree = render();
assert.equal(
  button(
    find(tree, (node) => node.props.role === 'group'),
    'QPSK 3/4✓',
  ).props['aria-pressed'],
  true,
);
const halfButton = find(
  tree,
  (node) =>
    node.type === 'button' &&
    node.props.title?.includes('Click to hide') &&
    text(node) === 'QPSK 1/2',
);
assert.match(halfButton.props.title, /5,000,000 symbols\/s/);
assert.match(halfButton.props.title, /1.25 dB/);
assert.match(halfButton.props.title, /separate amount unavailable/);
assert.match(halfButton.props.title, /independent reference/);
halfButton.props.onMouseEnter();
tree = render();
assert.ok(
  find(
    tree,
    (node) => node.type === 'path' && node.props.className === 'flat-map-contour highlighted',
  ),
);
for (let index = 0; index < 50; index++) {
  props = { ...props, currentPositionEcefM: samples.satellite_position_ecef_m[index % 3] };
  render();
}
assert.equal(pathBuilds, 1, 'Playback cursor updates do not rebuild track geometry');
assert.equal(
  JSON.stringify({ ...props, currentPositionEcefM: samples.satellite_position_ecef_m[1] }),
  saved,
  'Map navigation and mode selection leave scientific results unchanged',
);
const changes = [];
props = {
  ...props,
  selectedModes: ['half'],
  onSelectedModesChange: (value) => changes.push([...value]),
};
tree = render();
const controlledHalf = find(
  tree,
  (node) =>
    node.type === 'button' &&
    node.props.title?.includes('Click to hide') &&
    text(node) === 'QPSK 1/2',
);
controlledHalf.props.onClick();
assert.deepEqual(changes, [[]]);
props = { ...props, selectedModes: [], coverageState: 'loading' };
tree = render();
assert.match(text(tree), /COMPUTING CONTOURS/);
assert.match(text(tree), /No MODCODs selected/);
console.log(
  'Flat map controls passed: real component World/station/zoom/wheel/drag/keyboard handlers, pointer release, MODCOD menu and controlled selection, source/threshold/reserve tooltips, highlight, geometry memoization across 50 cursor updates and immutable scientific inputs. Browser pointer appearance remains unverified.',
);
