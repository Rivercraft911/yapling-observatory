import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { MissionRequests, canAdvanceMissionRun } from './missionRequests.ts';

async function load(filename, dependencies = {}) {
  const source = await readFile(new URL(filename, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => (slots[index] = value)];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useEffect() {},
    useCallback: (callback) => callback,
  };
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return {
    exports,
    render(name, props) {
      cursor = 0;
      return exports[name](props);
    },
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  for (const child of Array.isArray(tree) ? tree : [tree.props?.children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
const text = (tree) =>
  typeof tree === 'string'
    ? tree
    : (Array.isArray(tree) ? tree : [tree?.props?.children])
        .map((child) => (child ? text(child) : ''))
        .join('');
const button = (tree, label) =>
  find(tree, (node) => node.type === 'button' && text(node) === label);
const field = (tree, label) => find(tree, (node) => node.props?.label === label);
const link = () => ({
  spacecraft_antenna: 'patch',
  antenna_orientation_deg: [0, 0, 0],
  frequency_hz: 2.4e9,
  ground_peak_gain_dbi: 31,
  spacecraft_peak_gain_dbi: 6,
  ground_feed_roll_deg: 0,
  profile: { waveform: 'dvb_s2', modulation: 'QPSK', code_rate: 0.5 },
});
const starting = {
  name: 'Antenna flow fixture',
  antenna_variant: 'dipole',
  uplink: link(),
  downlink: link(),
  spacecraft: {
    wheels: [],
    mass_kg: 1,
    locked_inertia_kg_m2: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  },
  uhf_beacon: {
    antenna_variant: 'dipole',
    antenna_orientation_deg: [0, 0, 0],
    ground_feed_roll_deg: 0,
    ground_peak_gain_dbi: 15,
    radiation_efficiency: 1,
  },
};
const requests = [];
const missionModule = await load('./useMission.ts', {
  '../api': {
    api: async () => ({ scenario: structuredClone(starting) }),
    cloneScenario: structuredClone,
  },
  './missionRequests': { MissionRequests, canAdvanceMissionRun },
  './missionArchives': {
    requestMissionRun: async (path, options) => {
      requests.push({ path, scenario: JSON.parse(options.body).scenario });
      const run = { run_id: `run-${requests.length}`, status: 'complete', result: { samples: {} } };
      return { run, text: JSON.stringify(run) };
    },
  },
});
const renderMission = () => missionModule.render('useMission');
let mission = renderMission();
await mission.reload();
await renderMission().start();
const retained = renderMission().snapshot;
const archived = JSON.stringify(retained);

const radio = await load('../controls/RadioControls.tsx', {
  '../api': { cloneScenario: structuredClone },
  '../antenna/FieldModelDetails': {
    FieldModelDetails: 'field-model',
    profileEvidenceLabel: () => '',
  },
});
const uhf = await load('./MissionUhfControls.tsx', {
  '../api': {},
  '../controls/RadioControls': radio.exports,
});
const antennas = await load('./MissionAntennaControls.tsx', {
  '../controls/RadioControls': radio.exports,
  './MissionUhfControls': uhf.exports,
});
const hardware = await load('./MissionHardware.tsx', {
  '../api': { cloneScenario: structuredClone },
  '../controls/RadioControls': radio.exports,
  './MissionAntennaControls': antennas.exports,
});
let previewVariant = null;
const props = () => ({
  config: renderMission().config,
  edit: renderMission().edit,
  onAntennaVariant: (variant) => (previewVariant = variant),
});
button(hardware.render('MissionHardware', props()), 'Antennas').props.onClick();
const renderAntennas = () => {
  const selected = find(
    hardware.render('MissionHardware', props()),
    (node) => node.type === antennas.exports.MissionAntennaControls,
  );
  assert(selected);
  return antennas.render('MissionAntennaControls', selected.props);
};
const renderSband = () => {
  const selected = find(renderAntennas(), (node) => node.type === radio.exports.AntennaControls);
  return radio.render('AntennaControls', selected.props);
};
field(renderSband(), 'Patch peak').props.onChange(7.2);
assert.equal(renderMission().config.downlink.spacecraft_peak_gain_dbi, 7.2);
assert.equal(renderMission().config.uplink.spacecraft_peak_gain_dbi, 6);
field(renderSband(), 'Pattern').props.onChange('wire');
field(renderSband(), 'Wire assembly').props.onChange('turnstile');
assert.equal(renderMission().config.antenna_variant, 'turnstile');
assert.equal(previewVariant, 'turnstile');
assert.equal(
  field(renderSband(), 'Wire assembly').props.options.find((option) => option.value === 'v45')
    .disabled,
  true,
);
field(renderSband(), 'Ground dish gain').props.onChange(30);
let mount = find(renderSband(), (node) => node.type === radio.exports.AntennaMountControls);
let mountTree = radio.render('AntennaMountControls', mount.props);
field(mountTree, 'Mount Y').props.onChange(23);
field(mountTree, 'Ground feed roll').props.onChange(45);
button(renderAntennas(), 'Uplink').props.onClick();
field(renderSband(), 'Patch peak').props.onChange(5);
assert.equal(renderMission().config.downlink.spacecraft_peak_gain_dbi, 2.15);
assert.equal(field(renderSband(), 'Symbol rate'), undefined);
assert.equal(field(renderSband(), 'Profile'), undefined);

button(renderAntennas(), 'UHF').props.onClick();
const renderUhf = () => {
  const selected = find(renderAntennas(), (node) => node.type === uhf.exports.MissionUhfControls);
  assert.equal(selected.props.antennaOnly, true);
  return uhf.render('MissionUhfControls', selected.props);
};
field(renderUhf(), 'Spacecraft UHF antenna').props.onChange('turnstile');
field(renderUhf(), 'Ground Yagi gain').props.onChange(14);
field(renderUhf(), 'Radiation efficiency').props.onChange(85);
mount = find(renderUhf(), (node) => node.type === radio.exports.AntennaMountControls);
mountTree = radio.render('AntennaMountControls', mount.props);
field(mountTree, 'Mount X').props.onChange(12);
field(mountTree, 'Ground feed roll').props.onChange(-30);
assert.equal(field(renderUhf(), 'Beacon interval'), undefined);
assert.equal(field(renderUhf(), 'Bandwidth'), undefined);
assert.equal(field(renderUhf(), 'TX electrical'), undefined);
mission = renderMission();
assert.equal(JSON.stringify(mission.snapshot), archived);
assert.equal(mission.dirty, true);
await mission.start();
const submitted = requests.at(-1);
assert.equal(submitted.path, '/api/mission/runs');
assert.equal(submitted.scenario.antenna_variant, 'turnstile');
assert.equal(submitted.scenario.downlink.ground_peak_gain_dbi, 30);
assert.equal(submitted.scenario.downlink.ground_feed_roll_deg, 45);
assert.deepEqual(submitted.scenario.downlink.antenna_orientation_deg, [0, 23, 0]);
assert.equal(submitted.scenario.uplink.spacecraft_peak_gain_dbi, 5);
assert.equal(submitted.scenario.uhf_beacon.antenna_variant, 'turnstile');
assert.equal(submitted.scenario.uhf_beacon.ground_peak_gain_dbi, 14);
assert.equal(submitted.scenario.uhf_beacon.radiation_efficiency, 0.85);
assert.deepEqual(submitted.scenario.uhf_beacon.antenna_orientation_deg, [12, 0, 0]);
assert.equal(submitted.scenario.uhf_beacon.ground_feed_roll_deg, -30);
assert.equal(JSON.stringify(retained), archived);
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(app, /onAntennaVariant=\{setPreviewVariant\}/);
console.log(
  'Hardware antennas passed: shared edits reach the next run, direction isolation, mount/polarization, focused fields, preview callback and retained history.',
);
