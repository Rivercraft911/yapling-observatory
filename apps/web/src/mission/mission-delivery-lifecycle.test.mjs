import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual component with deterministic hooks and deferred API replies.
const slots = [];
let cursor = 0;
let effects = [];
const requests = [];
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [
      slots[index],
      (value) => {
        slots[index] = value;
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
const jsx = (type, props) => ({ type, props });
const source = await readFile(new URL('./MissionDeliveryControls.tsx', import.meta.url), 'utf8');
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
  AbortController,
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === '../controls/RadioControls') return { Field: 'field', Select: 'select' };
    if (name === '../api')
      return {
        api: (_url, options) => new Promise((resolve) => requests.push({ resolve, options })),
      };
    throw new Error(`Unexpected dependency ${name}`);
  },
});
let config = {
  uplink: { frequency_hz: 1, profile: { waveform: 'dvb_s2' } },
  downlink: { frequency_hz: 2, profile: { waveform: 'dvb_s2' } },
};
let edits = 0;
function render() {
  cursor = 0;
  effects = [];
  const tree = exports.MissionDeliveryControls({
    config,
    edit(change) {
      edits++;
      change(config);
    },
  });
  for (const effect of effects) effect();
  return tree;
}
function checkbox(element) {
  if (!element || typeof element !== 'object') return;
  if (element?.type === 'input' && element.props.type === 'checkbox') return element;
  const children = element?.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = checkbox(child);
    if (found) return found;
  }
}
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(checkbox(render()).props.disabled, true);
config = { ...config, uplink: { ...config.uplink, frequency_hz: 3 } };
render();
assert.equal(requests[0].options.signal.aborted, true);
assert.equal(
  checkbox(render()).props.disabled,
  false,
  'A link edit must release the loading state',
);
requests[0].resolve({ obsolete: true });
await new Promise(setImmediate);
assert.equal(edits, 0, 'A stale profile must not replace the edited links');
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(requests.length, 2, 'The receiver model must be loadable again');
requests[1].resolve({ fresh: true });
await new Promise(setImmediate);
assert.equal(edits, 1);
assert.equal(config.radio_delivery.fresh, true);
console.log('Receiver loading resets on link changes and rejects stale replies.');

const profile = {
  hardware_profile: 'generic_dvb_s2_reference',
  policy: 'adaptive',
  modes: [
    {
      mode_id: 'qpsk-half',
      modulation: 'QPSK',
      code_rate: '1/2',
      symbol_rate_sps: 123456,
      frame_size: 'normal',
      pilots: true,
      decode_threshold_esn0_db: 2.25,
      threshold_status: 'illustrative',
    },
  ],
  initial_mode_id: 'qpsk-half',
  schedule: [],
  acquisition_s: 7,
  reacquisition_s: 3,
  loss_hold_s: 2,
  minimum_dwell_s: 8,
  mode_change_s: 0.4,
  acquisition_margin_db: 2,
  hold_margin_db: 1,
  application_overhead_bits_per_frame: 128,
};
config = {
  ...config,
  radio_delivery: {
    schema_version: '0.1.0',
    uplink: structuredClone(profile),
    downlink: structuredClone(profile),
  },
};
let tree = render();
assert.equal(checkbox(tree).props['aria-label'], 'Adaptive MODCOD');
assert.equal(checkbox(tree).props.checked, true);
const receiverInputs = JSON.stringify(config.radio_delivery);
checkbox(tree).props.onChange({ target: { checked: false } });
assert.equal(config.radio_delivery.uplink.policy, 'fixed');
assert.equal(config.radio_delivery.downlink.policy, 'fixed');
assert.equal(config.radio_delivery.downlink.acquisition_s, 7);
assert.equal(config.radio_delivery.downlink.modes[0].decode_threshold_esn0_db, 2.25);
assert.equal(
  requests.length,
  2,
  'Policy switches preserve configured receiver inputs without refetching',
);
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(JSON.stringify(config.radio_delivery), receiverInputs);
config.radio_delivery.uplink.policy = 'fixed';
assert.equal(checkbox(render()).props['aria-checked'], 'mixed');
config.radio_delivery.downlink.policy = 'fixed';
config.radio_delivery.uplink.hardware_profile = 'esp32_s3_short_pair';
assert.equal(checkbox(render()).props.disabled, true);
console.log(
  'Adaptive switch exposes actual policies, preserves receiver tuning, handles mixed policies and respects hardware restrictions.',
);

config = { ...config, radio_delivery: undefined };
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(requests.length, 3);
config = {
  ...config,
  radio_delivery: {
    schema_version: '0.1.0',
    uplink: { ...structuredClone(profile), acquisition_s: 99 },
    downlink: { ...structuredClone(profile), acquisition_s: 88 },
  },
};
render();
assert.equal(
  requests[2].options.signal.aborted,
  true,
  'Replacing receiver inputs invalidates a pending load even with identical RF links',
);
requests[2].resolve({
  schema_version: '0.1.0',
  uplink: structuredClone(profile),
  downlink: structuredClone(profile),
});
await new Promise(setImmediate);
assert.equal(config.radio_delivery.uplink.acquisition_s, 99);
assert.equal(config.radio_delivery.downlink.acquisition_s, 88);
assert.equal(checkbox(render()).props.disabled, false);
console.log('A stale receiver reply cannot replace settings loaded from another mission.');
