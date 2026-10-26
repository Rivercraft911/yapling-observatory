import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { APIError } from '../api.ts';

async function harness(filename, component) {
  const source = await readFile(new URL(filename, import.meta.url), 'utf8');
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
      if (name === '../controls/RadioControls') return { Field: 'field', Select: 'select' };
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
  return {
    requests,
    render(props) {
      cursor = 0;
      effects = [];
      const tree = exports[component](props);
      for (const effect of effects) effect();
      return tree;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
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
const apply = (tree) => find(tree, (node) => node.type === 'button');
const alert = (tree) => find(tree, (node) => node.props?.role === 'alert');
const text = (tree) =>
  typeof tree === 'string' || typeof tree === 'number'
    ? String(tree)
    : (Array.isArray(tree) ? tree : [tree?.props?.children])
        .flat()
        .map((child) => (child == null ? '' : text(child)))
        .join('');
const flush = () => new Promise(setImmediate);
const profile = {
  waveform: 'dvb_s2',
  symbol_rate_sps: 1e6,
  modulation: 'QPSK',
  code_rate: 0.5,
  net_efficiency: 0.72,
  information_rate_bps: null,
  threshold_metric: 'esn0',
  threshold_db: 1,
  threshold_status: 'illustrative',
  engineering_reserve_db: 3,
};
const receiver = {
  hardware_profile: 'generic_dvb_s2_reference',
  assumptions: 'Custom receiver assumptions',
  modes: [{ mode_id: 'custom', symbol_rate_sps: 1e6, decode_threshold_esn0_db: 2.25 }],
  initial_mode_id: 'custom',
  policy: 'scheduled',
  schedule: [{ start_s: 90, mode_id: 'custom' }],
  acquisition_s: 17,
  application_overhead_bits_per_frame: 777,
};
const original = {
  name: 'Editable mission',
  power: { custom_load_w: 4 },
  uplink: { profile: structuredClone(profile) },
  downlink: { profile: structuredClone(profile) },
  radio_delivery: {
    schema_version: '0.1.0',
    uplink: structuredClone(receiver),
    downlink: structuredClone(receiver),
  },
};
const frozenHistory = JSON.stringify(original);
let config = structuredClone(original);
const channel = await harness('./MissionChannelControls.tsx', 'MissionChannelControls');
const committed = [];
const render = () =>
  channel.render({
    config,
    direction: 'downlink',
    edit(change) {
      const draft = structuredClone(config);
      change(draft);
      committed.push(draft);
      config = draft;
    },
  });
const reply = (request, rate = 16e6) => {
  const body = JSON.parse(request.options.body);
  return {
    profile: {
      ...body.profile,
      symbol_rate_sps: rate,
      channel_bandwidth_hz: body.channel_bandwidth_hz,
      rolloff: body.rolloff,
    },
    delivery: body.delivery
      ? {
          ...body.delivery,
          modes: body.delivery.modes.map((mode) => ({ ...mode, symbol_rate_sps: rate })),
        }
      : null,
    symbol_rate_sps: rate,
    channel_bandwidth_hz: body.channel_bandwidth_hz,
    rolloff: body.rolloff,
    assumptions: 'Numerical model response',
  };
};

let tree = render();
assert.equal(field(tree, 'Allocated bandwidth').props.value, 20);
assert.equal(field(tree, 'Roll-off').props.value, '0.35');
assert.match(text(tree), /Allocation unrecorded.*draft unapplied/);
assert.match(text(tree), /1 Msym\/s/);
assert.equal(
  channel.requests.length,
  0,
  'Opening legacy controls must not apply the draft allocation',
);
assert.equal(Object.hasOwn(config.downlink.profile, 'channel_bandwidth_hz'), false);
field(tree, 'Roll-off').props.onChange('0.25');
apply(render()).props.onClick();
const first = channel.requests[0];
assert.equal(first.path, '/api/mission/radio-channel');
assert.equal(first.options.method, 'POST');
assert.deepEqual(JSON.parse(first.options.body), {
  profile,
  delivery: receiver,
  channel_bandwidth_hz: 20e6,
  rolloff: 0.25,
});
assert.equal(apply(render()).props.disabled, true);
config = structuredClone(config);
config.power.custom_load_w = 7;
config.radio_delivery.uplink.acquisition_s = 23;
render();
assert.equal(
  first.options.signal.aborted,
  false,
  'Unrelated edits do not invalidate the requested direction',
);
const answer = reply(first);
first.resolve(answer);
await flush();
tree = render();
assert.equal(committed.length, 1);
assert.deepEqual(committed[0].downlink.profile, answer.profile);
assert.deepEqual(committed[0].radio_delivery.downlink, answer.delivery);
assert.equal(config.power.custom_load_w, 7);
assert.equal(config.radio_delivery.uplink.acquisition_s, 23);
assert.deepEqual(config.uplink.profile, profile);
assert.equal(config.radio_delivery.downlink.acquisition_s, 17);
assert.equal(config.radio_delivery.downlink.application_overhead_bits_per_frame, 777);
assert.deepEqual(config.radio_delivery.downlink.schedule, receiver.schedule);
assert.match(text(tree), /16 Msym\/s/);
assert.doesNotMatch(text(tree), /draft unapplied/);
assert.equal(apply(tree).props.disabled, false);

field(tree, 'Allocated bandwidth').props.onChange(24);
apply(render()).props.onClick();
const beforeReceiverEdit = committed.length;
config = structuredClone(config);
config.radio_delivery.downlink.acquisition_s = 99;
render();
assert.equal(channel.requests[1].options.signal.aborted, true);
assert.equal(apply(render()).props.disabled, false);
channel.requests[1].resolve(reply(channel.requests[1]));
await flush();
assert.equal(committed.length, beforeReceiverEdit);
assert.equal(config.radio_delivery.downlink.acquisition_s, 99);

apply(render()).props.onClick();
config = structuredClone(config);
config.downlink.profile = { ...profile, symbol_rate_sps: 5e6 };
render();
assert.equal(channel.requests[2].options.signal.aborted, true);
channel.requests[2].reject(new APIError('Not Found', 404));
await flush();
assert.equal(
  alert(render()),
  undefined,
  'A replaced profile must reject obsolete success and error responses',
);
assert.equal(config.downlink.profile.symbol_rate_sps, 5e6);

apply(render()).props.onClick();
field(render(), 'Allocated bandwidth').props.onChange(12);
assert.equal(channel.requests[3].options.signal.aborted, true);
channel.requests[3].resolve(reply(channel.requests[3]));
await flush();
assert.equal(config.downlink.profile.symbol_rate_sps, 5e6);
assert.equal(field(render(), 'Allocated bandwidth').props.value, 12);
assert.equal(apply(render()).props.disabled, false);

apply(render()).props.onClick();
const beforeError = JSON.stringify(config);
channel.requests[4].reject(
  new APIError('Hardware profile requires its supported symbol rates', 422),
);
await flush();
assert.equal(
  alert(render()).props.children,
  'Hardware profile requires its supported symbol rates',
);
assert.equal(JSON.stringify(config), beforeError);
assert.equal(apply(render()).props.disabled, false);
apply(render()).props.onClick();
channel.requests[5].reject(new APIError('Not Found', 404));
await flush();
assert.match(alert(render()).props.children, /local service.*older than this interface/);
assert.equal(channel.requests.length, 6, 'An unsupported route must not trigger a fallback');
apply(render()).props.onClick();
channel.unmount();
assert.equal(channel.requests[6].options.signal.aborted, true);
channel.requests[6].resolve(reply(channel.requests[6]));
await flush();
assert.equal(committed.length, beforeReceiverEdit);
assert.equal(JSON.stringify(original), frozenHistory);

const withoutReceiver = await harness('./MissionChannelControls.tsx', 'MissionChannelControls');
let noReceiverConfig = { ...structuredClone(original), radio_delivery: undefined };
const renderNoReceiver = () =>
  withoutReceiver.render({
    config: noReceiverConfig,
    direction: 'uplink',
    edit(change) {
      const draft = structuredClone(noReceiverConfig);
      change(draft);
      noReceiverConfig = draft;
    },
  });
apply(renderNoReceiver()).props.onClick();
assert.equal(JSON.parse(withoutReceiver.requests[0].options.body).delivery, null);
withoutReceiver.requests[0].resolve(reply(withoutReceiver.requests[0]));
await flush();
assert.equal(
  noReceiverConfig.radio_delivery,
  undefined,
  'Applying a channel must not enable a receiver model',
);
assert.equal(noReceiverConfig.uplink.profile.channel_bandwidth_hz, 20e6);
assert.equal(noReceiverConfig.downlink.profile.channel_bandwidth_hz, undefined);
renderNoReceiver();

const direct = await harness('../controls/RadioControls.tsx', 'RadioControls');
let link = {
  ...structuredClone(original.downlink),
  profile: { ...profile, channel_bandwidth_hz: 20e6, rolloff: 0.35 },
};
const renderDirect = () =>
  direct.render({
    direction: 'downlink',
    link,
    catalog: { presets: [] },
    onChange(change) {
      const draft = structuredClone(link);
      change(draft);
      link = draft;
    },
  });
tree = renderDirect();
assert.equal(field(tree, 'Symbol rate').props.disabled, true);
field(tree, 'Symbol rate').props.onChange(2);
assert.equal(link.profile.symbol_rate_sps, 2e6);
assert.equal(Object.hasOwn(link.profile, 'channel_bandwidth_hz'), false);
assert.equal(Object.hasOwn(link.profile, 'rolloff'), false);
assert.equal(field(renderDirect(), 'Symbol rate').props.disabled, false);
console.log(
  'Channel controls passed: explicit legacy drafts, authoritative backend rates, atomic profile/receiver edits, isolated directions, preserved custom inputs and stale/unmounted request rejection.',
);
