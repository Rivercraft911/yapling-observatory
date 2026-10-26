import assert from 'node:assert/strict';
import { plotDefinitions, plotTraces } from './registry.ts';

const definition = (id) => plotDefinitions.find((item) => item.id === id);
const ids = ['magnetic_field', 'magnetic_dipole', 'control_torque', 'control_residual'];
const samples = {
  time_s: [0, 30],
  gnc: {
    magnetic_field_body_t: [
      [-20e-6, 0, 40e-6],
      [1e-6, 2e-6, 3e-6],
    ],
    magnetic_dipole_body_am2: [
      [0.2, 0, -0.1],
      [0, 0.05, 0.15],
    ],
    requested_torque_body_nm: [
      [10e-6, 2e-6, -3e-6],
      [0, 2e-6, 0],
    ],
    actual_torque_body_nm: [
      [4e-6, 2e-6, -3e-6],
      [0, 1e-6, 0],
    ],
    residual_torque_body_nm: [
      [6e-6, 0, 0],
      [0, 1e-6, 0],
    ],
  },
};
assert.deepEqual(
  definition('magnetic_field')
    .read(samples)
    .map((t) => t.values),
  [
    [-20, 1],
    [0, 2],
    [40, 3],
  ],
);
assert.deepEqual(
  definition('magnetic_dipole')
    .read(samples)
    .map((t) => t.values),
  [
    [0.2, 0],
    [0, 0.05],
    [-0.1, 0.15],
  ],
);
assert.equal(definition('control_torque').read(samples).length, 6);
assert.deepEqual(definition('control_torque').read(samples)[3], {
  label: 'Achieved x',
  values: [4, 0],
});
assert.deepEqual(
  definition('control_residual')
    .read(samples)
    .map((t) => t.values),
  [
    [6, 0],
    [0, 1],
    [0, 0],
  ],
);
for (const id of ids) {
  for (const legacy of [{ time_s: [0, 30] }, { time_s: [0, 30], gnc: {} }]) {
    const traces = plotTraces(definition(id), { run: { result: { samples: legacy } } });
    assert(traces.every((trace) => trace.values.every((value) => value === null)));
  }
}
console.log(
  'GNC traces passed: SI conversion, signed body axes, separate achieved torque and unavailable legacy telemetry.',
);

const torqueTraces = plotTraces(definition('control_torque'), { run: { result: { samples } } });
for (let axis = 0; axis < 3; axis++) {
  assert.equal(torqueTraces[axis].color, torqueTraces[axis + 3].color);
  assert.deepEqual(torqueTraces[axis].dash, [3, 3]);
  assert.equal(torqueTraces[axis + 3].dash, undefined);
}
