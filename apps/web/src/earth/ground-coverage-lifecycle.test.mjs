import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./useGroundCoverage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const slots = [];
const requests = [];
let cursor = 0,
  effects = [];
const changed = (previous, dependencies) =>
  !previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]));
const hooks = {
  useMemo(compute, dependencies) {
    const index = cursor++;
    if (changed(slots[index], dependencies)) slots[index] = { dependencies, value: compute() };
    return slots[index].value;
  },
  useState(initial) {
    const index = cursor++;
    slots[index] ??= { value: initial };
    return [
      slots[index].value,
      (value) => {
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
      },
    ];
  },
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (changed(previous, dependencies))
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
  },
};
class APIError extends Error {
  constructor(status) {
    super('Not Found');
    this.status = status;
  }
}
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  AbortController,
  Error,
  require(name) {
    if (name === 'react') return hooks;
    if (name === '../api')
      return {
        APIError,
        api: (path, options) =>
          new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
      };
    throw new Error(`Unexpected import ${name}`);
  },
});
let scenario = { name: 'Archived scenario', downlink: { tx_power_w: 2.5 } };
let direction = 'downlink',
  altitude = null,
  loss = 0;
const original = JSON.stringify(scenario);
const render = () => {
  cursor = 0;
  effects = [];
  const result = exports.useGroundCoverage(scenario, direction, altitude, loss);
  effects.forEach((effect) => effect());
  return result;
};
const flush = () => new Promise(setImmediate);
assert.equal(render().state, 'loading');
assert.equal(requests[0].path, '/api/mission/coverage');
assert.deepEqual(JSON.parse(requests[0].options.body), {
  scenario,
  direction,
  altitude_m: null,
  polarization_loss_db: 0,
});
render();
assert.equal(requests.length, 1, 'Cursor renders do not recalculate coverage');
requests[0].resolve({ altitude_m: 550000, contours: [] });
await flush();
assert.equal(render().data.altitude_m, 550000);
direction = 'uplink';
assert.equal(render().data, null, 'Old-direction contours disappear before the new reply');
assert.equal(requests[0].options.signal.aborted, true);
altitude = 600000;
render();
assert.equal(requests[1].options.signal.aborted, true);
requests[1].resolve({ altitude_m: 550000, contours: ['stale'] });
requests[2].resolve({ altitude_m: 600000, contours: ['current'] });
await flush();
assert.equal(render().data.contours[0], 'current');
loss = 3;
assert.equal(render().data, null);
requests[3].reject(new APIError(404));
await flush();
assert.match(render().error, /updated local service/);
render().retry();
assert.equal(render().state, 'loading');
assert.equal(requests.length, 5);
requests[4].resolve({ altitude_m: 600000, contours: ['recovered'] });
await flush();
assert.equal(render().data.contours[0], 'recovered');

scenario = { ...scenario, name: 'Next run' };
assert.equal(render().state, 'loading');
assert.equal(render().error, '');
const last = requests.at(-1);
for (const slot of slots) slot?.cleanup?.();
assert.equal(last.options.signal.aborted, true);
last.resolve({ altitude_m: 777, contours: ['unmounted'] });
await flush();
assert.equal(render().data, null);
scenario = null;
assert.equal(render().state, 'unavailable');
assert.equal(
  JSON.stringify({ name: 'Archived scenario', downlink: { tx_power_w: 2.5 } }),
  original,
);
console.log(
  'Coverage lifecycle passed: immutable run inputs, no cursor requests, stale direction/height replies rejected, explicit polarization assumption, clear missing-service error and unmount cancellation.',
);
