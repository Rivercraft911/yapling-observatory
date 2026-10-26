import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as reference from './runReference.ts';

const slots = [];
let position = 0;
let pending = [];
const changed = (before, after) => !before || after.some((value, index) => value !== before[index]);
const hooks = {
  useRef(value) {
    return (slots[position++] ??= { current: value });
  },
  useState(value) {
    const index = position++;
    slots[index] ??= { value };
    return [
      slots[index].value,
      (next) => {
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      },
    ];
  },
  useMemo(compute, deps) {
    const index = position++;
    if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: compute() };
    return slots[index].value;
  },
  useEffect(effect, deps) {
    const index = position++;
    if (changed(slots[index]?.deps, deps))
      pending.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
  },
};
const requests = [];
const api = (path, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, body });
  if (path.endsWith('/catalog')) return Promise.resolve({ examples: [] });
  if (path.endsWith('/reference-request'))
    return Promise.resolve({
      model:
        body.link.spacecraft_antenna === 'wire'
          ? body.antenna_variant
          : body.link.spacecraft_antenna,
      frequency_hz: body.link.frequency_hz,
      orientation_deg: body.link.antenna_orientation_deg,
      patch_peak_gain_dbi: body.link.spacecraft_peak_gain_dbi,
      efficiency: 1,
    });
  if (path.endsWith('/pattern') || path.endsWith('/probe')) return new Promise(() => {});
  throw new Error(`Unexpected route: ${path}`);
};
const element = (type, props) => ({ type, props });
const exports = {};
const source = await readFile(new URL('../AntennaLab.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
new Function('require', 'exports', compiled)((name) => {
  if (name === 'react') return hooks;
  if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
  if (name === 'react-dom') return { createPortal: (tree) => tree };
  if (name === './api') return { api };
  if (name === './antenna/runReference') return reference;
  if (name === './antenna/AngularCut') return { AngularCut: 'AngularCut' };
  if (name === './antenna/LobeView') return { LobeView: 'LobeView' };
  if (name === './antenna/FieldModelDetails')
    return { FieldModelDetails: 'FieldModelDetails', profileEvidenceLabel: () => 'Reference' };
  if (name === './antenna.css') return {};
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);
const link = (spacecraft_antenna, frequency_hz) => ({
  spacecraft_antenna,
  frequency_hz,
  antenna_orientation_deg: [11, -22, 33],
  spacecraft_peak_gain_dbi: 1,
});
const snapshot = {
  scenario: { antenna_variant: 'v45', uplink: link('wire', 1), downlink: link('wire', 2) },
  run: {
    run_id: 'computed',
    scenario_hash: 'archive',
    result: {
      manifest: {
        scenario: {
          antenna_variant: 'turnstile',
          uplink: link('wire', 438e6),
          downlink: link('patch', 2.4e9),
        },
        frames: {
          inertial: 'FIXED_EPOCH_MEAN_EQUATOR_EQUINOX_APPROX',
          quaternion: 'Hamilton scalarfirst q_B_from_I',
        },
      },
      samples: {
        time_s: [0],
        satellite_position_m: [[7e6, 0, 0]],
        station_position_m: [[6e6, 0, 0]],
        q_body_from_inertial_wxyz: [[1, 0, 0, 0]],
        visible: [false],
        active_direction: ['downlink'],
        uplink: { polarization_coupling: [0.9] },
        downlink: { polarization_coupling: [0.8] },
      },
    },
  },
};
let tree;
const render = (current = snapshot) => {
  position = 0;
  pending = [];
  tree = exports.AntennaLab({ snapshot: current, sampleIndex: 0 });
  pending.forEach((effect) => effect());
  return tree;
};
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 140));
};
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
};
const text = (node) =>
  node == null
    ? ''
    : typeof node !== 'object'
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join('')
        : text(node.props?.children);
render();
await settle();
render();
await settle();
render();
const last = (path) => requests.filter((request) => request.path.endsWith(path)).at(-1)?.body;
assert.equal(
  last('/reference-request').link.frequency_hz,
  438e6,
  'Reference uses archived UL, not draft',
);
assert.equal(last('/pattern').model, 'turnstile');
assert.deepEqual(
  last('/probe').run_probe.spacecraft_position_m,
  [7e6, 0, 0],
  'Run source automatically follows actual sampled LOS',
);
assert.deepEqual(last('/probe').run_probe.q_body_from_inertial_wxyz, [1, 0, 0, 0]);
assert(text(tree).includes('Below station mask · geometric LOS'));
assert(!text(tree).includes('0.900'), 'Below-mask feed coupling is not presented as a usable link');
const modelSelect = find(tree, (node) => node.props?.['aria-label'] === 'Antenna reference model');
assert.equal(
  find(modelSelect, (node) => node.type === 'option' && node.props.value === 'v45'),
  null,
);
for (const model of ['bent_v_up_45', 'bent_v_out_45'])
  assert(find(modelSelect, (node) => node.type === 'option' && node.props.value === model));
find(tree, (node) => node.props?.['aria-label'] === 'Run antenna link').props.onChange({
  target: { value: 'downlink' },
});
render();
await settle();
render();
await settle();
assert.equal(last('/reference-request').link.frequency_hz, 2.4e9);
assert.equal(last('/pattern').model, 'patch');
assert.equal(last('/probe').frequency_hz, 2.4e9);
const broken = structuredClone(snapshot);
broken.run.result.manifest.frames.quaternion = 'unrecognized';
const count = requests.filter((request) => request.path.endsWith('/probe')).length;
render(broken);
await settle();
assert.equal(
  requests.filter((request) => request.path.endsWith('/probe')).length,
  count,
  'Invalid run geometry cannot fall back to manual probe',
);
assert(text(tree).includes('Run LOS unavailable'));
render(null);
await settle();
render(null);
assert(text(tree).includes('Run antenna unavailable'));
const noRunLobe = find(tree, (node) => node.type === 'LobeView');
assert.equal(noRunLobe.props.pattern, null);
assert.equal(noRunLobe.props.probe, null);
assert.equal(noRunLobe.props.geometryVisible, false);
assert.equal(noRunLobe.props.lobeVisible, false);
assert(
  requests.every((request) => request.path.startsWith('/api/antenna-lab/')),
  'Never starts a synthetic pass or mutates a mission',
);
for (const slot of slots) slot?.cleanup?.();
console.log(
  'Antenna Lab run path passed: archived UL/DL configuration, automatic sampled LOS, no invalid-geometry/manual fallback, hidden unsupported option, retained up/out references, blocked-link label and honest no-history state.',
);
