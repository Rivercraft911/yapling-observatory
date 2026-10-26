import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { APIError } from '../api.ts';

const source = await readFile(new URL('./RadioControls.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const slots = [];
const requests = [];
let cursor = 0;
let effects = [];
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { value: initial };
    return [
      slots[index].value,
      (value) => {
        slots[index].value = value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    return (slots[index] ??= { current: initial });
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
const exports = {};
const jsx = (type, props) => ({ type, props });
vm.runInNewContext(compiled, {
  exports,
  AbortController,
  Error,
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === '../antenna/FieldModelDetails')
      return { FieldModelDetails: 'model-details', profileEvidenceLabel: () => '' };
    if (name === '../api')
      return {
        APIError,
        cloneScenario: structuredClone,
        api: (path, options) =>
          new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
      };
    throw new Error(`Unexpected dependency: ${name}`);
  },
});
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
const field = (tree, label) => find(tree, (node) => node.props?.label === label);
const button = (tree, label) =>
  find(tree, (node) => node.type === 'button' && node.props.children === label);
const output = (tree) => find(tree, (node) => node.type === 'output');
const alert = (tree) => find(tree, (node) => node.props?.role === 'alert');
const flush = () => new Promise(setImmediate);
const baseline = {
  frequency_hz: 2.4e9,
  ground_peak_gain_dbi: 31,
  tx_power_w: 5,
  profile: { waveform: 'dvb_s2', modulation: 'QPSK', code_rate: 0.5 },
};
let link = structuredClone(baseline);
let direction = 'uplink';
let edits = 0;
function render() {
  cursor = 0;
  effects = [];
  const tree = exports.GroundDishEstimator({
    direction,
    link,
    onChange(change) {
      const next = structuredClone(link);
      change(next);
      link = next;
      edits++;
    },
  });
  for (const effect of effects) effect();
  return tree;
}
const reply = (index, gain = 30.989507143555264) => ({
  ...JSON.parse(requests[index].options.body),
  peak_gain_dbi: gain,
  assumptions: 'Analytical far-field boresight only',
  source: { url: 'https://ntrs.nasa.gov/citations/19830016274', locator: 'NASA-TM-84953 p.8' },
});
let tree = render();
assert.equal(field(tree, 'Dish diameter').props.value, 1.9);
assert.equal(field(tree, 'Aperture efficiency · assumed').props.value, null);
assert.equal(button(tree, 'Estimate gain').props.disabled, true);
assert.equal(
  requests.length,
  0,
  'Opening a historical link must not assume an efficiency or request a gain',
);
assert.equal(link.ground_peak_gain_dbi, 31);
field(tree, 'Aperture efficiency · assumed').props.onChange(55);
button(render(), 'Estimate gain').props.onClick();
assert.equal(requests[0].path, '/api/ground-antennas/dish-gain');
assert.deepEqual(JSON.parse(requests[0].options.body), {
  diameter_m: 1.9,
  frequency_hz: 2.4e9,
  aperture_efficiency: 0.55,
});
assert.equal(button(render(), 'Estimating…').props.disabled, true);
link = { ...link, ground_peak_gain_dbi: 29 };
render();
assert.equal(requests[0].options.signal.aborted, true);
requests[0].resolve(reply(0));
await flush();
assert.equal(output(render()), undefined);
assert.equal(link.ground_peak_gain_dbi, 29, 'A late estimate cannot overwrite a manual gain');
assert.equal(edits, 0);

button(render(), 'Estimate gain').props.onClick();
link = { ...link, frequency_hz: 2.42e9 };
render();
assert.equal(requests[1].options.signal.aborted, true);
requests[1].reject(new APIError('Obsolete carrier error', 422));
await flush();
assert.equal(alert(render()), undefined);
assert.equal(button(render(), 'Estimate gain').props.disabled, false);

button(render(), 'Estimate gain').props.onClick();
field(render(), 'Dish diameter').props.onChange(2);
assert.equal(requests[2].options.signal.aborted, true);
requests[2].resolve(reply(2));
await flush();
assert.equal(
  output(render()),
  undefined,
  'Changing a calculator draft rejects its obsolete estimate',
);
button(render(), 'Estimate gain').props.onClick();
assert.equal(JSON.parse(requests[3].options.body).diameter_m, 2);
requests[3].resolve(reply(3, 31.25));
await flush();
tree = render();
assert.equal(output(tree).props.children.join(''), '31.25 dBi');
assert.equal(link.ground_peak_gain_dbi, 29, 'Estimating alone does not apply gain');
const obsoleteApply = button(tree, 'Apply gain').props.onClick;
field(tree, 'Dish diameter').props.onChange(1.9);
obsoleteApply();
assert.equal(edits, 0, 'An obsolete Apply button cannot apply a replaced draft');

button(render(), 'Estimate gain').props.onClick();
requests[4].resolve(reply(4));
await flush();
tree = render();
button(tree, 'Apply gain').props.onClick();
assert.equal(edits, 1);
assert.equal(link.ground_peak_gain_dbi, 30.989507143555264);
assert.equal(link.frequency_hz, 2.42e9);
assert.equal(link.tx_power_w, 5);
assert.deepEqual(link.profile, baseline.profile);
assert.equal(output(render()), undefined, 'Applied output must clear after the link changes');

button(render(), 'Estimate gain').props.onClick();
direction = 'downlink';
render();
assert.equal(requests[5].options.signal.aborted, true);
requests[5].resolve(reply(5));
await flush();
assert.equal(
  output(render()),
  undefined,
  'Changing direction rejects the other direction estimate',
);

button(render(), 'Estimate gain').props.onClick();
requests[6].resolve(reply(6, 75));
await flush();
assert.equal(button(render(), 'Apply gain').props.disabled, true);
button(render(), 'Apply gain').props.onClick();
assert.equal(edits, 1, 'An estimate outside the link contract cannot apply');
button(render(), 'Estimate gain').props.onClick();
requests[7].reject(new APIError('Not Found', 404));
await flush();
assert.match(alert(render()).props.children, /current antenna endpoint/);
assert.equal(requests.length, 8, 'A missing endpoint cannot silently fall back to browser physics');
button(render(), 'Estimate gain').props.onClick();
for (const slot of slots) slot?.cleanup?.();
assert.equal(requests[8].options.signal.aborted, true);
requests[8].resolve(reply(8));
await flush();
assert.equal(edits, 1, 'An unmounted calculator cannot apply a response');
assert.equal(baseline.ground_peak_gain_dbi, 31);
console.log(
  'Ground dish controls passed: explicit efficiency, manual gain retention, separate estimate/apply and stale draft/link/direction/unmount rejection.',
);
