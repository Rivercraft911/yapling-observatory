import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { finiteValue, powerReadout } from './powerReadout.ts';

for (const missing of [null, undefined, NaN, Infinity, -Infinity, '12', false, {}]) {
  assert.equal(finiteValue(missing), null);
}
assert.equal(finiteValue(0), 0);
assert.equal(finiteValue(-2.5), -2.5);
const power = {
  potential_bus_w: [12, 0, NaN],
  requested_load_w: [3.25, 4.5, Infinity],
  net_bus_w: [8.75, -4.5, null],
  battery_soc: [0.4, 0.37, undefined],
  energy_fraction: [0.81, 0.8, 0.79],
};
const snapshot = {
  run: {
    result: {
      samples: { time_s: [0, 30, 60], power },
      summary: {
        energy_j: {
          generated_bus_j: 36000,
          requested_load_j: 18000,
          chemical_storage_delta_j: -7200,
        },
      },
    },
  },
};
const original = structuredClone(snapshot);
assert.deepEqual(powerReadout(snapshot, 0), {
  solar: 12,
  draw: 3.25,
  net: 8.75,
  soc: 0.4,
  usedSolarJ: 36000,
  loadJ: 18000,
  storedDeltaJ: -7200,
});
assert.deepEqual(powerReadout(snapshot, 1), {
  solar: 0,
  draw: 4.5,
  net: -4.5,
  soc: 0.37,
  usedSolarJ: 36000,
  loadJ: 18000,
  storedDeltaJ: -7200,
});
const unknown = powerReadout(snapshot, 2);
for (const key of ['solar', 'draw', 'net', 'soc']) assert.equal(unknown[key], null);
for (const missing of [
  null,
  { run: {} },
  { run: { result: { samples: {}, summary: {} } } },
  { run: { result: { samples: { power: {} }, summary: {} } } },
]) {
  assert.deepEqual(powerReadout(missing, 0), {
    solar: null,
    draw: null,
    net: null,
    soc: null,
    usedSolarJ: null,
    loadJ: null,
    storedDeltaJ: null,
  });
}
const legacy = structuredClone(snapshot);
delete legacy.run.result.samples.power.battery_soc;
assert.equal(
  powerReadout(legacy, 0).soc,
  null,
  'Energy fraction must never replace electrical SOC',
);
legacy.run.result.summary.energy_j = {
  generated_bus_j: NaN,
  requested_load_j: undefined,
  chemical_storage_delta_j: Infinity,
};
for (const key of ['usedSolarJ', 'loadJ', 'storedDeltaJ'])
  assert.equal(powerReadout(legacy, 0)[key], null);
assert.deepEqual(snapshot, original, 'The readout must not change returned samples or run totals');

const component = await readFile(new URL('./PowerStatus.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(component, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const element = (type, props) => ({ type, props });
const exports = {};
new Function('require', 'exports', compiled)((name) => {
  if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element };
  if (name === './TracePlot')
    return {
      closestIndex: (times, cursor) =>
        times.reduce(
          (best, time, index) =>
            Math.abs(time - cursor) < Math.abs(times[best] - cursor) ? index : best,
          0,
        ),
    };
  if (name === './powerReadout') return { powerReadout };
  if (name === './power-status.css') return {};
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);
const text = (node) =>
  node == null
    ? ''
    : typeof node !== 'object'
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join('')
        : text(node.props?.children);
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
};
const expanded = exports.PowerStatus({ snapshot, cursorTime: 0, expanded: true });
const labels = text(expanded);
for (const label of ['12.00 W', '3.25 W', '+8.75 W', '40.00 %', '10.00 Wh', '5.00 Wh', '-2.00 Wh'])
  assert(labels.includes(label), label);
assert(!labels.includes('81.00 %'));
const replay = text(exports.PowerStatus({ snapshot, cursorTime: 29, expanded: true }));
assert(replay.includes('-4.50 W') && replay.includes('37.00 %'));
assert(
  replay.includes('10.00 Wh') && replay.includes('-2.00 Wh'),
  'Whole-run energy is independent of replay cursor',
);
const compact = exports.PowerStatus({ snapshot, cursorTime: 0 });
assert.equal(
  find(compact, (node) => node.props?.['aria-label'] === 'Whole run energy'),
  null,
);
const missingTree = exports.PowerStatus({ snapshot: legacy, cursorTime: 0, expanded: true });
assert(text(missingTree).includes('SOC—'));
assert(!text(missingTree).includes('NaN') && !text(missingTree).includes('Infinity'));
assert.equal(exports.PowerStatus({ snapshot: null, cursorTime: 0 }), null);
console.log(
  'Power readout passed: returned bus power, electrical SOC distinct from energy fraction, cursor selection, signed W/Wh, whole-run units, immutable histories and unavailable legacy/nonfinite values.',
);
