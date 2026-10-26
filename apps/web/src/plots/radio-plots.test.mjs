import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { plotDefinitions, plotTraces } from './registry.ts';

const definition = (id) => plotDefinitions.find((item) => item.id === id);
const samples = {
  time_s: [0, 5, 10, 15],
  visible: [true, true, false, true],
  active_direction: ['downlink', 'uplink', 'downlink', 'downlink'],
  radio_active: [true, true, true, false],
  radio_delivery: {
    uplink: {
      ready_payload_rate_bps: [0, 2000000, 0, null],
      selected_margin_db: [null, 0, 10, null],
      mode_id: ['q', 'q', 'q', 'q'],
      receiver_state: ['idle', 'locked', 'idle', 'idle'],
    },
    downlink: {
      ready_payload_rate_bps: [5000000, 0, 0, null],
      selected_margin_db: [3, null, 12, null],
      mode_id: ['p', 'p', 'p', 'p'],
      receiver_state: ['locked', 'idle', 'idle', 'idle'],
    },
  },
};
assert.deepEqual(
  definition('frame_rate')
    .read(samples)
    .map((t) => t.values),
  [
    [0, 2000, 0, null],
    [5000, 0, 0, null],
  ],
);
assert.deepEqual(
  definition('selected_margin')
    .read(samples)
    .map((t) => t.values),
  [
    [null, 0, null, null],
    [3, null, null, null],
  ],
);
const legacy = { run: { result: { samples: { time_s: [0, 5], visible: [true, true] } } } };
assert.deepEqual(
  plotTraces(definition('frame_rate'), legacy).map((t) => t.values),
  [
    [null, null],
    [null, null],
  ],
);
const source = await readFile(new URL('./LinkStatus.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const exports = {};
const jsx = (type, props) => ({ type, props });
vm.runInNewContext(compiled, {
  exports,
  require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './TracePlot') return { closestIndex: (times, t) => times.indexOf(t) };
    throw new Error(name);
  },
});
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined || node === false) return '';
  if (typeof node !== 'object') return String(node);
  return text(node.props?.children);
}
const snapshot = {
  run: {
    result: {
      samples,
      manifest: {
        scenario: {
          radio_delivery: {
            uplink: {
              policy: 'adaptive',
              modes: [{ mode_id: 'q', modulation: 'QPSK', code_rate: '1/4' }],
            },
            downlink: {
              policy: 'adaptive',
              modes: [{ mode_id: 'p', modulation: '8PSK', code_rate: '8/9' }],
            },
          },
        },
      },
    },
  },
};
const readout = (t) => text(exports.LinkStatus({ snapshot, cursorTime: t }));
assert.match(readout(0), /DL window.*UL QPSK 1\/4.*DL 8PSK 8\/9/);
assert.match(readout(5), /UL window/);
assert.match(readout(10), /Below mask/);
assert.match(readout(15), /Radio idle/);
assert.equal(exports.LinkStatus({ snapshot: null, cursorTime: 0 }), null);
console.log(
  'Radio plots preserve inactive zero, unknown gaps, contact masking and archived MODCOD identity.',
);

const uhf = {
  time_s: [0, 30],
  uhf_beacon: {
    available_received_power_dbm: [null, -120],
    received_power_dbm: [null, null],
    margin_db: [null, null],
    output_interval_tx_fraction: [0, 0.03],
    scheduled_beacons_completed: [0, 1],
    electrical_w: [2.5, 0.0198],
    heat_w: [1.9, 0.0198],
  },
};
assert.deepEqual(
  definition('uhf_signal')
    .read(uhf)
    .map((t) => t.values),
  [
    [null, -120],
    [null, null],
  ],
);
assert.deepEqual(definition('uhf_duty').read(uhf)[0].values, [0, 3]);
assert.deepEqual(definition('uhf_beacons').read(uhf)[0].values, [0, 1]);
assert.deepEqual(definition('uhf_margin').read(uhf)[0].values, [null, null]);
console.log('UHF charts preserve unresolved margin, actual TX gaps and interval beacon occupancy.');

assert.deepEqual(
  definition('uhf_power')
    .read({
      uhf_beacon: {
        output_interval_electrical_w: [0, 0.1],
        output_interval_heat_w: [0, 0.08],
        electrical_w: [2.5, 0.0198],
      },
    })
    .map((trace) => trace.values),
  [
    [0, 0.1],
    [0, 0.08],
  ],
);

const thermalSamples = {
  time_s: [0, 10],
  thermal: {
    node_absorbed_environment_w: { bus: [1.5, 2], panel: [20, 12] },
    node_emitted_ir_w: { bus: [3, 3.1], panel: [15, 16] },
  },
};
const retained = structuredClone(thermalSamples);
for (const [id, field] of [
  ['absorbed_heat', 'node_absorbed_environment_w'],
  ['radiated_heat', 'node_emitted_ir_w'],
]) {
  assert.deepEqual(
    definition(id).read(thermalSamples),
    Object.entries(thermalSamples.thermal[field]).map(([label, values]) => ({ label, values })),
  );
  assert.deepEqual(definition(id).read({ time_s: [0, 10] }), []);
}
assert.deepEqual(thermalSamples, retained);
console.log(
  'Thermal radiation charts expose returned node balances and leave missing legacy data absent.',
);
