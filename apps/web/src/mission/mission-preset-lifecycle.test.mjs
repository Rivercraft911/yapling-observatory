import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { APIError } from '../api.ts';
import { MissionRequests, canAdvanceMissionRun } from './missionRequests.ts';

const source = await readFile(new URL('./useMission.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const slots = [];
const requests = [];
let cursor = 0;
let effects = [];
const changed = (before, after) =>
  !before || after.some((value, index) => !Object.is(value, before[index]));
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
  useCallback(callback, dependencies) {
    const index = cursor++;
    if (changed(slots[index]?.dependencies, dependencies))
      slots[index] = { dependencies, callback };
    return slots[index].callback;
  },
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (changed(previous?.dependencies, dependencies))
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
  },
};
const request = (path, options = {}) =>
  new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  AbortController,
  Error,
  queueMicrotask,
  JSON,
  require(name) {
    if (name === 'react') return hooks;
    if (name === '../api') return { api: request, APIError, cloneScenario: structuredClone };
    if (name === './missionRequests') return { MissionRequests, canAdvanceMissionRun };
    if (name === './missionArchives') return { requestMissionRun: request };
    throw new Error(`Unexpected hook dependency: ${name}`);
  },
});
function render() {
  cursor = 0;
  effects = [];
  const state = exports.useMission();
  for (const effect of effects) effect();
  return state;
}
const flush = () => new Promise(setImmediate);

let state = render();
assert.equal(requests[0].path, '/api/mission/default');
const initialConfig = { name: 'Initial mission', duration_s: 60 };
requests[0].resolve({ scenario: initialConfig });
await flush();
state = render();
assert.equal(state.loading, false);
const started = state.start();
assert.equal(requests[1].path, '/api/mission/runs');
const completed = { run_id: 'retained-run', status: 'complete', result: { samples: {} } };
requests[1].resolve({ run: completed, text: '{"run_id":"retained-run"}' });
await started;
state = render();
const snapshot = state.snapshot;
assert(snapshot);
state.edit((draft) => {
  draft.name = 'Edited draft';
});
state = render();
const draft = state.config;

const missingPreset = state.loadPreset('terminator');
assert.equal(requests[2].path, '/api/mission/demo/terminator');
assert.equal(render().loading, true);
requests[2].reject(new APIError('Not Found', 404));
await missingPreset;
state = render();
assert.equal(state.loading, false);
assert.strictEqual(state.config, draft, 'A missing preset must retain the draft inputs');
assert.strictEqual(state.snapshot, snapshot, 'A preset request must preserve completed results');
assert.match(state.error, /Terminator SSO could not load/);
assert.match(state.error, /local service.*older than this interface/);
assert.equal(requests.length, 3, 'A missing route must not trigger a different preset or default');

const retry = state.loadPreset('terminator');
assert.equal(requests[3].path, '/api/mission/demo/terminator');
assert.equal(render().error, '');
assert.equal(render().loading, true);
const terminator = { name: 'Terminator SSO', duration_s: 86400 };
requests[3].resolve({ scenario: terminator });
await retry;
state = render();
assert.strictEqual(state.config, terminator);
assert.strictEqual(state.run, completed);
assert.strictEqual(state.snapshot, snapshot);
assert.equal(snapshot.scenario.name, 'Initial mission');
assert.equal(state.error, '');
assert.equal(state.loading, false);

const daylight = state.loadPreset('daylight');
assert.equal(requests[4].path, '/api/mission/demo/daytime-pass');
const daylightConfig = { name: 'Daylight passes', duration_s: 28000 };
requests[4].resolve({ scenario: daylightConfig });
await daylight;
state = render();
assert.strictEqual(state.config, daylightConfig);
assert.strictEqual(state.snapshot, snapshot);

const rejectedPreset = state.loadPreset('terminator');
requests[5].reject(new APIError('Orbit input invalid', 422));
await rejectedPreset;
state = render();
assert.equal(state.error, 'Orbit input invalid', 'Other failures must keep their original detail');
assert.strictEqual(state.config, daylightConfig);
assert.equal(state.loading, false);

const obsolete = state.loadPreset('terminator');
const latest = render().loadPreset('daylight');
assert.equal(requests[6].options.signal.aborted, true);
requests[7].resolve({ scenario: daylightConfig });
await latest;
requests[6].reject(new APIError('Not Found', 404));
await obsolete;
state = render();
assert.equal(
  state.error,
  '',
  'An obsolete route error must not replace a newer successful selection',
);
assert.equal(state.loading, false);
assert.strictEqual(state.config, daylightConfig);
assert.strictEqual(state.snapshot, snapshot);
console.log(
  'Mission preset lifecycle passed: exact routes, actionable missing-service errors, safe retry, retained inputs/results and stale response rejection.',
);
