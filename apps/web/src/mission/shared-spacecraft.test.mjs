import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadControls(filename, selectedMode) {
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
    const Fragment = 'Fragment';
    const Field = 'Field', Select = 'Select';
    const useEffect = () => {};
    const cloneScenario = structuredClone;
    ${filename.includes('Thermal') ? "const MissionModeLoads = 'MissionModeLoads', MissionConopsControls = 'MissionConopsControls';" : ''}
    const useState = (value) => [value === 'sun_pointing' ? ${JSON.stringify(selectedMode || 'sun_pointing')} : value, () => {}];
  `;
  return import(
    `data:text/javascript;base64,${Buffer.from(harness + compiled).toString('base64')}`
  );
}
function find(tree, predicate) {
  if (tree && !Array.isArray(tree) && predicate(tree)) return tree;
  for (const child of Array.isArray(tree) ? tree : tree?.props?.children || []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}
const node = (node_id) => ({
  node_id,
  initial_temperature_k: 290,
  heat_capacity_j_k: 300,
  solar_absorptivity: 0.9,
  infrared_emissivity: 0.75,
  radiating_area_m2: 0.04,
  space_view_factor: 1,
});
const modes = ['sun_pointing', 'ground_tracking', 'imaging', 'detumble'];
const starting = {
  name: 'shared mission',
  duration_s: 3600,
  power: {
    thermal: {
      nodes: [node('bus'), node('battery')],
      conductive_links: [{ first: 'bus', second: 'battery', conductance_w_k: 0.2 }],
    },
    panels: [
      { panel_id: 'body', thermal_node_id: 'bus', solar_absorptivity: 0.9 },
      { panel_id: 'other', thermal_node_id: 'battery', solar_absorptivity: 0.8 },
    ],
    mode_loads: modes.map((mode, index) => ({
      mode,
      loads: [{ component_id: 'obc', electrical_w: index + 1 }],
    })),
  },
};
const history = structuredClone(starting);
const original = JSON.stringify(history);
let config = structuredClone(starting);
const edit = (change) => {
  const draft = structuredClone(config);
  change(draft);
  config = draft;
};
const { MissionThermalControls } = await loadControls('./MissionThermalControls.tsx');
let tree = MissionThermalControls({ config, edit });
for (const [label, value, field, expected] of [
  ['Initial temperature', 20, 'initial_temperature_k', 293.15],
  ['Heat capacity', 450, 'heat_capacity_j_k', 450],
  ['IR emissivity ε', 0.84, 'infrared_emissivity', 0.84],
  ['Radiating area', 0.05, 'radiating_area_m2', 0.05],
]) {
  find(tree, (item) => item.type === 'Field' && item.props.label === label).props.onChange(value);
  assert.equal(config.power.thermal.nodes[0][field], expected);
}
find(
  tree,
  (item) => item.type === 'Field' && item.props.label === 'Solar absorptivity α',
).props.onChange(0.85);
assert.equal(config.power.thermal.nodes[0].solar_absorptivity, 0.85);
assert.equal(config.power.panels[0].solar_absorptivity, 0.85);
assert.equal(config.power.panels[1].solar_absorptivity, 0.8);
find(tree, (item) => item.type === 'Field' && item.props.label === 'battery').props.onChange(0.4);
assert.equal(config.power.thermal.conductive_links[0].conductance_w_k, 0.4);
assert.equal(config.power.thermal.nodes[1].heat_capacity_j_k, 300);
assert.equal(JSON.stringify(history), original);

for (const [index, mode] of modes.entries()) {
  const { MissionModeLoads } = await loadControls('./MissionModeLoads.tsx', mode);
  tree = MissionModeLoads({ config, edit });
  assert(find(tree, (item) => item.type === 'button' && item.props['aria-pressed']));
  const before = structuredClone(config.power.mode_loads);
  find(tree, (item) => item.type === 'Field' && item.props.label === 'obc').props.onChange(
    8 + index,
  );
  for (let other = 0; other < modes.length; other++)
    assert.equal(
      config.power.mode_loads[other].loads[0].electrical_w,
      other === index ? 8 + index : before[other].loads[0].electrical_w,
    );
  assert.equal(JSON.stringify(history), original);
}
config.downlink = { tx_power_w: 2, tx_feed_loss_db: 0.3, spacecraft_antenna: 'patch' };
Object.assign(config.power, {
  spacecraft_tx_electrical_w: 10.8,
  spacecraft_receive_w: 1.5,
  radio_idle_w: 0.5,
  transmit_radiation_efficiency: 1,
});
const { MissionRadioPower } = await loadControls('./MissionRadioPower.tsx');
tree = MissionRadioPower({ config, edit });
find(tree, (item) => item.type === 'Field' && item.props.label === 'TX electrical').props.onChange(
  12,
);
assert.equal(config.power.spacecraft_tx_electrical_w, 12);
assert.equal(config.downlink.tx_power_w, 2);
find(tree, (item) => item.type === 'Field' && item.props.label === 'RF port output').props.onChange(
  4,
);
assert.equal(config.downlink.tx_power_w, 4);
assert.equal(config.power.spacecraft_tx_electrical_w, 12);
assert.equal(JSON.stringify(history), original);

config.power.battery = {
  initial_energy_fraction: 0.6,
  total_capacity_wh: null,
  cells: { cell_model: 'NCR18650GA', cell_capacity_mah: 3350, series_count: 2, parallel_count: 2 },
  max_charge_bus_w: 10,
  max_discharge_bus_w: 30,
  electrical: {
    model: 'ncr18650ga_linghu2019_rint',
    initial_soc: 0.5,
    resistance_scale: 1,
    cell_min_voltage_v: 2.5,
    cell_max_voltage_v: 4.2,
    cell_max_charge_current_a: 1.475,
    cell_max_discharge_current_a: 10,
    charge_temperature_min_k: 283.15,
    charge_temperature_max_k: 318.15,
    discharge_temperature_min_k: 253.15,
    discharge_temperature_max_k: 333.15,
    heat_node_id: 'battery',
  },
};
const { MissionBatteryControls } = await loadControls('./MissionBatteryControls.tsx');
tree = MissionBatteryControls({ config, edit });
find(tree, (item) => item.type === 'Field' && item.props.label === 'Initial charge').props.onChange(
  30,
);
assert.equal(config.power.battery.electrical.initial_soc, 0.3);
assert.equal(config.power.battery.initial_energy_fraction, 0.6);
find(
  tree,
  (item) => item.type === 'Select' && item.props.label === 'Electrical model',
).props.onChange('energy_only');
assert.equal(Object.hasOwn(config.power.battery, 'electrical'), false);
assert.equal(config.power.battery.initial_energy_fraction, 0.6);
assert.equal(JSON.stringify(history), original);

const render = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(render, /<MissionPowerControls config=\{scenario\} edit=\{mission\.edit\}/);
assert.match(render, /<MissionThermalControls\s+config=\{scenario\}\s+edit=\{mission\.edit\}/);
assert.match(render, /<MissionHardware config=\{scenario\} edit=\{mission\.edit\}/);
assert.match(render, /independentStudy === 'gnc'/);
assert.match(render, /section=\{independentStudy\}/);
console.log(
  'Shared spacecraft controls passed: mission draft callbacks, all four mode profiles, thermal/PV absorptivity agreement, conductive links, separate electrical/RF inputs, optional battery charge state, retained history, and independent-study routing.',
);
