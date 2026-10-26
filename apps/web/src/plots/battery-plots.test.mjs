import assert from 'node:assert/strict';
import { plotDefinitions, plotTraces } from './registry.ts';

const definition = (id) => plotDefinitions.find((item) => item.id === id);
const legacy = {
  power: { battery_voltage_v: [null, null], battery_current_a: [null, null] },
};
for (const id of [
  'battery_voltage',
  'battery_current',
  'battery_soc',
  'battery_remaining_charge',
  'battery_heat',
]) {
  const returned = definition(id).read(legacy);
  assert.equal(returned[0].label, 'Unavailable');
  assert(returned[0].values.every((value) => value == null));
}
const power = {
  battery_voltage_v: [7.1, 7.0],
  battery_current_a: [0.5, -0.2],
  battery_soc: [0.5, 0.49],
  battery_remaining_charge_ah: [3.35, 3.283],
  battery_ohmic_heat_w: [0.1, 0.02],
  energy_fraction: [0.45, 0.44],
};
const samples = { time_s: [0, 30], power };
assert.deepEqual(definition('battery_soc').read(samples)[0].values, [50, 49]);
assert.deepEqual(definition('charge').read(samples)[0].values, [45, 44]);
assert.deepEqual(definition('battery_current').read(samples)[0].values, [0.5, -0.2]);
assert.equal(definition('battery_voltage').read(samples)[0].label, 'Terminal');
assert.deepEqual(
  definition('battery_remaining_charge').read(samples)[0].values,
  power.battery_remaining_charge_ah,
);
assert.deepEqual(definition('battery_heat').read(samples)[0].values, power.battery_ohmic_heat_w);
const snapshot = { run: { result: { samples } } };
assert.deepEqual(plotTraces(definition('battery_heat'), snapshot)[0].values, [0.1, 0.02]);
assert.deepEqual(
  plotTraces(definition('battery_heat'), {
    run: { result: { samples: { time_s: [0, 30], power: {} } } },
  })[0].values,
  [null, null],
);
console.log(
  'Battery plots passed: model-dependent availability, returned V/I, separate charge SOC and energy fraction, Ah and ohmic heat, without synthesized missing values.',
);
