import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const slots = [];
let cursor = 0;
let effects = [];
const calls = [];
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
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
    }
  },
};
const jsx = (type, props) => {
  if (typeof type === 'string' && props.ref && !props.ref.current) props.ref.current = {};
  return { type, props };
};
class Scene {
  constructor() {
    calls.push(['construct']);
  }
  setHistory(value) {
    calls.push(['history', value]);
  }
  updateSample(value) {
    calls.push(['sample', value]);
  }
  setDisplayTimeSource() {}
  setAsset() {}
  setCameraMode(value) {
    calls.push(['camera', value]);
  }
  setFollowEarthLock(value) {
    calls.push(['earth-lock', value]);
  }
  setThermalView() {}
  setGroundTargetPicker() {}
  setRenderingVisible(value) {
    calls.push(['rendering', value]);
  }
  dispose() {
    calls.push(['dispose']);
  }
}
const source = await readFile(new URL('../EarthView.tsx', import.meta.url), 'utf8');
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
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === './earth/EarthScene') return { EarthScene: Scene };
    if (name === './earth.css') return {};
    if (name === './earth/GroundTrackWorkspace') return { GroundTrackWorkspace: 'flat-map' };
    if (name === './mission/linkDisplay') return { linkDisplayState: () => 'BELOW MASK' };
    throw new Error(`Unexpected import ${name}`);
  },
});
let snapshot = null;
let sampleIndex = 0;
const render = () => {
  cursor = 0;
  effects = [];
  const tree = exports.EarthView({ snapshot, sampleIndex });
  for (const effect of effects) effect();
  return tree;
};
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object') return text(node.props?.children);
  return node == null || typeof node === 'boolean' ? '' : String(node);
};
const find = (node, predicate) => {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return undefined;
  return predicate(node) ? node : find(node.props?.children, predicate);
};
const button = (tree, label) =>
  find(tree, (node) => node.type === 'button' && text(node) === label);
const lastRendering = () => calls.filter(([kind]) => kind === 'rendering').at(-1);
const map = (tree) => find(tree, (node) => node.type === 'flat-map');
assert.equal(button(render(), 'Ground track').props.disabled, true);
snapshot = {
  scenario: { epoch_utc: '2026-10-25T23:59:59Z', antenna_variant: 'dipole' },
  run: { run_id: 'ground-test', result: { samples: { time_s: [0, 2] } } },
};
const before = JSON.stringify(snapshot);
let tree = render();
button(tree, 'Ground track').props.onClick();
tree = render();
assert.equal(button(tree, 'Ground track').props['aria-pressed'], true);
assert.deepEqual(lastRendering(), ['rendering', false]);
assert.equal(map(tree).props.windowSeconds, 10800);
assert.equal(map(tree).props.snapshot, snapshot);
assert.equal(button(tree, 'Globe'), undefined);
const window = find(
  tree,
  (node) => node.type === 'select' && node.props['aria-label'] === 'Ground-track window',
);
window.props.onChange({ target: { value: 'all' } });
tree = render();
assert.equal(map(tree).props.windowSeconds, Infinity);
assert.deepEqual(lastRendering(), ['rendering', false]);
const cameraCalls = calls.filter(([kind]) => kind === 'camera').length;
sampleIndex = 1;
tree = render();
assert.equal(
  calls.filter(([kind]) => kind === 'camera').length,
  cameraCalls,
  'Telemetry never changes camera mode',
);
assert.equal(
  calls.filter(([kind]) => kind === 'construct').length,
  1,
  'Changing samples does not recreate the renderer',
);
assert.match(text(tree), /2026-10-26/);
assert.match(text(tree), /00:00:01/);
assert.equal(
  JSON.stringify(snapshot),
  before,
  'Display controls leave archived inputs and results unchanged',
);
button(tree, 'Follow spacecraft').props.onClick();
tree = render();
assert.deepEqual(lastRendering(), ['rendering', true]);
assert.equal(map(tree), undefined);
assert.equal(button(tree, 'Follow spacecraft').props['aria-pressed'], true);
assert.equal(button(tree, 'Earth lock').props['aria-pressed'], false);
const beforeLock = calls.filter(([kind]) =>
  ['history', 'sample', 'camera', 'construct'].includes(kind),
);
button(tree, 'Earth lock').props.onClick();
tree = render();
assert.equal(button(tree, 'Earth lock').props['aria-pressed'], true);
assert.deepEqual(calls.filter(([kind]) => kind === 'earth-lock').at(-1), ['earth-lock', true]);
assert.deepEqual(
  calls.filter(([kind]) => ['history', 'sample', 'camera', 'construct'].includes(kind)),
  beforeLock,
  'The lock changes only follow-camera view state',
);
assert.equal(JSON.stringify(snapshot), before);
button(tree, 'Earth lock').props.onClick();
tree = render();
assert.equal(button(tree, 'Earth lock').props['aria-pressed'], false);
assert.deepEqual(calls.filter(([kind]) => kind === 'earth-lock').at(-1), ['earth-lock', false]);
button(tree, 'Ground track').props.onClick();
tree = render();
assert.equal(map(tree).props.windowSeconds, Infinity);
assert.deepEqual(lastRendering(), ['rendering', false]);
button(tree, 'Earth').props.onClick();
tree = render();
assert.deepEqual(lastRendering(), ['rendering', true]);
assert.equal(map(tree), undefined);
assert.equal(button(tree, 'Earth').props['aria-pressed'], true);
console.log(
  'Ground-track controls passed: flat map routing, hidden GPU pause/resume, window selection, stable renderer/camera on telemetry, unchanged Run and UTC day rollover.',
);
