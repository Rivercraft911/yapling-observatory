import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { unloadingStatusLabels } from './unloadingStatus.ts';

async function loadControls(filename) {
  const source = await readFile(new URL(filename, import.meta.url), 'utf8');
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'element',
        jsxFragmentFactory: 'Fragment',
      },
    })
    .outputText.replace(/^import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const harness = `
    const element = (type, props, ...children) => ({type, props: {...props, children}});
    const Fragment = 'Fragment', Field = 'Field', Select = 'Select';
    const useEffect = () => {};
    const useState = (value) => [value, () => {}];
    const cloneScenario = structuredClone;
    const unloadingStatusLabels = ${JSON.stringify(unloadingStatusLabels)};
  `;
  return import(
    `data:text/javascript;base64,${Buffer.from(harness + compiled).toString('base64')}`
  );
}
function find(tree, predicate) {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && predicate(tree)) return tree;
  for (const child of Array.isArray(tree) ? tree : tree?.props?.children || []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return (Array.isArray(tree) ? tree : tree?.props?.children || []).map(text).join('');
}
const field = (tree, label) =>
  find(tree, (item) => item.type === 'Field' && item.props.label === label);
const select = (tree, label) =>
  find(tree, (item) => item.type === 'Select' && item.props.label === label);
const checkbox = (tree, label) =>
  find(tree, (item) => item.type === 'label' && text(item).trim() === label).props.children[0];
const readout = (tree) =>
  find(tree, (item) => item.props['aria-label'] === 'Simulated wheel unloading');
const { MissionHardware } = await loadControls('./MissionHardware.tsx');
const { MissionGncControls } = await loadControls('./MissionGncControls.tsx');
const wheel = {
  enabled: true,
  initial_speed_rpm: 1000,
  spec: {
    spin_inertia_kg_m2: 694.5e-9,
    max_speed_rpm: 8000,
    max_motor_torque_nm: 23e-6,
    constant_torque_until_rpm: 4000,
    idle_power_w: 0.4,
    max_bus_power_w: 0.5,
    motor_torque_constant_nm_a: 0.001,
    winding_resistance_ohm: 1,
    non_ohmic_drive_efficiency: 0.8,
    viscous_friction_nm_s: 0,
    regenerative_efficiency: 0,
  },
};
let config = {
  clocks: { controller_period_s: 2 },
  magnetic_model: 'igrf14_degree13',
  spacecraft: {
    mass_kg: 1,
    locked_inertia_kg_m2: [
      [0.01, 0, 0],
      [0, 0.02, 0],
      [0, 0, 0.03],
    ],
    wheels: [wheel],
    magnetorquer: {
      enabled: true,
      spec: { max_dipole_am2: 0.2 },
      full_axis_power_w: [0.1, 0.1, 0.1],
    },
    controller: 'quaternion_pd',
    pointing_reference: 'instantaneous_zero_rate',
    free_roll: false,
    roll_rate_damping: true,
    proportional_nm_per_rad: [0.000001, 0.000001, 0.000001],
    derivative_nm_s_per_rad: [0.00001, 0.00001, 0.00001],
  },
};
const history = structuredClone(config);
const originalHistory = JSON.stringify(history);
const edit = (change) => {
  const draft = structuredClone(config);
  change(draft);
  config = draft;
};
const render = (props = {}) => MissionGncControls({ config, edit, ...props });
let tree = render();
assert.equal(select(tree, 'Wheel unloading').props.value, 'disabled');
assert.deepEqual(select(tree, 'Wheel unloading').props.options, [
  { value: 'disabled', label: 'Disabled' },
  { value: 'enabled', label: 'Enabled' },
]);
assert.equal(field(tree, 'Decay time constant').props.value, 600);
assert.equal(field(tree, 'Decay time constant').props.disabled, true);
assert.equal(Object.hasOwn(config.spacecraft, 'magnetic_unloading_enabled'), false);
assert.equal(Object.hasOwn(config.spacecraft, 'magnetic_unloading_time_constant_s'), false);
assert.match(text(readout(tree)), /ReplayUnavailable/);
select(tree, 'Wheel unloading').props.onChange('enabled');
assert.equal(config.spacecraft.magnetic_unloading_enabled, true);
assert.equal(Object.hasOwn(config.spacecraft, 'magnetic_unloading_time_constant_s'), false);
tree = render();
assert.equal(field(tree, 'Decay time constant').props.disabled, false);
field(tree, 'Decay time constant').props.onChange(90);
assert.equal(config.spacecraft.magnetic_unloading_time_constant_s, 90);
select(render(), 'Wheel unloading').props.onChange('disabled');
tree = render();
assert.equal(config.spacecraft.magnetic_unloading_enabled, false);
assert.equal(field(tree, 'Decay time constant').props.value, 90);
assert.equal(field(tree, 'Decay time constant').props.disabled, true);
select(tree, 'Wheel unloading').props.onChange('enabled');
assert.equal(field(render(), 'Decay time constant').props.value, 90);

let hardware = MissionHardware({ config, edit });
assert.equal(select(hardware, 'Controller'), null);
assert.equal(select(hardware, 'Wheel unloading'), null);
assert.equal(field(hardware, 'ω₀'), null);
assert.equal(field(render(), 'm'), null);
assert.equal(field(render(), 'τ max'), null);
field(hardware, 'm').props.onChange(1.25);
field(hardware, 'Jx').props.onChange(0.015);
field(hardware, 'τ max').props.onChange(0.04);
assert.equal(config.spacecraft.mass_kg, 1.25);
assert.equal(config.spacecraft.locked_inertia_kg_m2[0][0], 0.015);
assert.equal(config.spacecraft.wheels[0].spec.max_motor_torque_nm, 0.00004);
checkbox(hardware, 'Reaction wheels').props.onChange({ target: { checked: false } });
assert.match(text(render()), /0 wheels · MTQ enabled/);
assert.match(text(render()), /Needs wheels/);
select(render(), 'Wheel unloading').props.onChange('disabled');
assert.equal(
  config.spacecraft.magnetic_unloading_enabled,
  false,
  'Unavailable hardware must not prevent disabling the saved intent',
);
hardware = MissionHardware({ config, edit });
checkbox(hardware, 'Reaction wheels').props.onChange({ target: { checked: true } });
checkbox(hardware, 'Magnetorquers').props.onChange({ target: { checked: false } });
assert.match(text(render()), /1 wheel · MTQ disabled/);
select(render(), 'Wheel unloading').props.onChange('enabled');
assert.match(text(render()), /Needs MTQ/);
hardware = MissionHardware({ config, edit });
checkbox(hardware, 'Magnetorquers').props.onChange({ target: { checked: true } });
hardware = MissionHardware({ config, edit });
field(hardware, 'm max').props.onChange(0);
assert.match(text(render()), /Zero MTQ authority/);
field(hardware, 'm max').props.onChange(0.2);
select(render(), 'Controller').props.onChange('coast');
assert.match(text(render()), /Controller inactive/);
select(render(), 'Controller').props.onChange('quaternion_pd');
field(render(), 'W1 initial speed').props.onChange(-1200);
assert.equal(config.spacecraft.wheels[0].initial_speed_rpm, -1200);
select(render(), 'Pointing reference').props.onChange('moving_boresight');
assert.equal(config.spacecraft.free_roll, true);
assert.equal(checkbox(render(), 'Free roll').props.disabled, true);
field(render(), 'Kp x').props.onChange(0.000002);
assert.equal(config.spacecraft.proportional_nm_per_rad[0], 0.000002);
select(render(), 'Earth field').props.onChange('igrf14_degree1');
assert.equal(Object.hasOwn(config, 'magnetic_model'), false);
select(render(), 'Earth field').props.onChange('igrf14_degree13');
assert.equal(config.magnetic_model, 'igrf14_degree13');
config.clocks.controller_period_s = 100;
assert.match(text(render()), /Time constant below controller interval/);
select(render(), 'Wheel unloading').props.onChange('disabled');
assert.doesNotMatch(text(render()), /Time constant below controller interval/);

const samples = {
  time_s: [0, 30, 60, 90, 120],
  gnc: {
    unloading_status: [
      'disabled',
      'active',
      'controller_inactive',
      'hardware_unavailable',
      'field_unavailable',
    ],
  },
};
for (const [sampleIndex, expected] of [
  [0, 'Disabled'],
  [1, 'Active controller'],
  [2, 'Inactive · controller / mode'],
  [3, 'Inactive · hardware'],
  [4, 'Inactive · field'],
]) {
  tree = render({ samples, sampleIndex });
  assert.match(text(readout(tree)), new RegExp(`T\\+${samples.time_s[sampleIndex]} s`));
  assert.equal(text(find(readout(tree), (item) => item.type === 'strong')), expected);
}
assert.equal(
  select(render({ samples, sampleIndex: 1 }), 'Wheel unloading').props.value,
  'disabled',
);
assert.match(text(readout(render({ samples, sampleIndex: 1 }))), /Active controller/);
select(render(), 'Wheel unloading').props.onChange('enabled');
assert.match(text(readout(render({ samples, sampleIndex: 0 }))), /Disabled/);
for (const props of [{}, { samples: { time_s: [0] } }, { samples, sampleIndex: 100 }]) {
  assert.match(text(readout(render(props))), /Unavailable/);
}
assert.equal(
  JSON.stringify(history),
  originalHistory,
  'Shared input edits must preserve the computed history',
);
const inspector = await readFile(new URL('./MissionInspector.tsx', import.meta.url), 'utf8');
assert.match(inspector, /<MissionGncControls/);
assert.match(inspector, /samples=\{mission\.snapshot\?\.run\.result\?\.samples\}/);
assert.match(inspector, /sampleIndex=\{sampleIndex\}/);
assert.doesNotMatch(inspector, /<MissionHardware/);
console.log(
  'Earth GNC controls passed: explicit unloading intent, retained decay time, actual replay states, unavailable legacy telemetry, shared hardware edits, preserved history, guidance and initial wheel speed routing.',
);
