import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as timeWindow from '../plots/timeWindow.ts';
import { missionDisplaySnapshot } from '../mission/displaySnapshot.ts';

const compile = async (filename) =>
  ts.transpileModule(await readFile(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const element = (type, props) => ({ type, props });
const geometry = {};
vm.runInNewContext(await compile('./SpacecraftInspector.tsx'), {
  exports: geometry,
  require: (name) =>
    name === 'react/jsx-runtime' ? { jsx: element, jsxs: element } : { OPTIONAL_MODULES: [] },
});
let starts = 0;
let cancels = 0;
const mission = {
  config: {
    name: 'Editable spacecraft',
    duration_s: 3600,
    antenna_variant: 'dipole',
    orbit: { elements: { epoch_utc: '2026-10-26T00:00:00Z' } },
    clocks: { output_step_s: 30 },
    spacecraft: { wheels: [], magnetorquer: null, mass_kg: 1.5 },
    power: { panels: [{ efficiency: 0.29 }] },
  },
  busy: false,
  start: () => starts++,
  cancel: () => cancels++,
  edit(change) {
    const draft = structuredClone(this.config);
    change(draft);
    this.config = draft;
  },
};
mission.edit = mission.edit.bind(mission);
mission.snapshot = {
  scenario: structuredClone(mission.config),
  run: {
    run_id: 'retained-run',
    status: 'complete',
    result: {
      summary: { end_reason: 'requested_duration' },
      events: [],
      samples: {
        time_s: [0, 30],
        active_direction: ['downlink', 'downlink'],
        visible: [true, true],
        elevation_deg: [12, 13],
        range_m: [1000000, 900000],
      },
    },
  },
};
mission.run = mission.snapshot.run;
const retained = JSON.stringify(mission.snapshot);
const slots = [];
let cursor = 0;
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (value) => (slots[index] = typeof value === 'function' ? value(slots[index]) : value),
    ];
  },
  useRef(initial) {
    const index = cursor++;
    return (slots[index] ??= { current: initial });
  },
  useEffect() {},
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
  lazy: () => 'LazyView',
  Suspense: 'Suspense',
};
const storage = { getItem: () => null };
const app = {};
vm.runInNewContext(await compile('../App.tsx'), {
  exports: app,
  window: { innerWidth: 1440, innerHeight: 900, localStorage: storage },
  localStorage: storage,
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' };
    if (name === './mission/useMission') return { useMission: () => mission };
    if (name === './live/useLiveMission') return { useLiveMission: () => ({ active: false }) };
    if (name === './plots/timeWindow') return timeWindow;
    if (name === './mission/displaySnapshot') return { missionDisplaySnapshot };
    if (name === './spacecraft/SpacecraftInspector') return geometry;
    if (name === './plots/TracePlot')
      return { closestIndex: () => 0, formatValue: (value) => String(value ?? '—') };
    return new Proxy({}, { get: (_, key) => key });
  },
});
const render = () => {
  cursor = 0;
  return app.default();
};
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  for (const child of Array.isArray(tree) ? tree : [tree.props?.children]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
const text = (tree) =>
  tree == null
    ? ''
    : typeof tree !== 'object'
      ? String(tree)
      : (Array.isArray(tree) ? tree : [tree.props?.children]).map(text).join('');
const button = (tree, label) =>
  find(tree, (node) => node.type === 'button' && text(node).trim() === label);
const enterSpacecraft = () => button(render(), 'Spacecraft').props.onClick();

for (const busy of [false, true]) {
  mission.busy = busy;
  mission.run = busy ? { run_id: 'active-run', status: 'running' } : mission.snapshot.run;
  const activeRun = mission.run;
  for (const [section, component] of [
    ['Hardware', 'MissionHardware'],
    ['Power', 'MissionPowerControls'],
    ['Thermal', 'MissionThermalControls'],
    ['GNC', 'MissionGncControls'],
  ]) {
    enterSpacecraft();
    button(render(), section).props.onClick();
    const tree = render();
    const controls = find(tree, (node) => node.type === component);
    controls.props.edit((draft) => {
      draft.power.panels[0].efficiency = 0.28;
    });
    const draft = mission.config;
    const action = button(tree, 'Update on Earth ↗');
    assert(action, `${section}: update action is visible`);
    assert(!action.props.disabled, `${section}: navigation stays available during a run`);
    action.props.onClick();
    const earth = find(render(), (node) => node.type === 'MissionInspector');
    assert(earth, `${section}: returns to Earth`);
    assert.equal(earth.props.mission.config, draft);
    assert.equal(earth.props.mission.config.power.panels[0].efficiency, 0.28);
    assert.equal(mission.run, activeRun);
    assert.equal(JSON.stringify(mission.snapshot), retained);
    assert.equal(starts, 0);
    assert.equal(cancels, 0);
  }
}
enterSpacecraft();
button(render(), 'Geometry').props.onClick();
let inspector = find(render(), (node) => node.type === geometry.SpacecraftInspector);
inspector.props.onVariant('turnstile');
inspector = find(render(), (node) => node.type === geometry.SpacecraftInspector);
button(geometry.SpacecraftInspector(inspector.props), 'Update on Earth').props.onClick();
assert.equal(mission.config.antenna_variant, 'turnstile');
assert.equal(JSON.stringify(mission.snapshot), retained);
assert.equal(starts, 0);
assert.equal(cancels, 0);
const earth = find(render(), (node) => node.type === 'MissionInspector');
earth.props.onRun();
assert.equal(starts, 1, 'Earth retains its explicit run action');
assert.equal(cancels, 0);
console.log(
  'Spacecraft update passed: all tabs return staged inputs to Earth, active/completed histories survive, no run starts or cancels, and Earth retains explicit run control.',
);
