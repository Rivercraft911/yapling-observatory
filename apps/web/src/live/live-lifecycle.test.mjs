import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { LiveHistory } from './liveHistory.ts';

const source = await readFile(new URL('./useLiveMission.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const flush = () => new Promise(setImmediate);

function harness(savedId) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const storage = new Map(savedId ? [['ssi-live-session', savedId]] : []);
  const changed = (before, after) =>
    !before || after.some((value, i) => !Object.is(value, before[i]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (next) => {
          slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
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
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    Error,
    crypto: { randomUUID: () => 'test-command' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    require(name) {
      if (name === 'react') return hooks;
      if (name === './liveHistory') return { LiveHistory };
      if (name === '../api')
        return {
          api: (path, options = {}) =>
            new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
        };
      throw new Error(`Unexpected hook dependency: ${name}`);
    },
  });
  return {
    requests,
    storage,
    render() {
      cursor = 0;
      effects = [];
      const value = exports.useLiveMission();
      for (const effect of effects) effect();
      return value;
    },
    poll() {
      assert(timers.size > 0, 'The active restored session must continue polling');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

const config = {
  name: 'Archived mission',
  duration_s: 120,
  antenna_variant: 'dipole',
  orbit: { elements: { epoch_utc: '2026-10-25T00:00:00Z' } },
  clocks: { output_step_s: 10 },
  station: {},
  uplink: {},
  downlink: {},
  schedule: {},
  provenance: [],
};
const session = (id, time = 0) => ({
  live_id: id,
  status: 'running',
  initial_scenario: config,
  initial_scenario_id: 'initial-id',
  initial_scenario_hash: 'initial-hash',
  computed_time_s: time,
  requested_duration_s: 120,
  speed: 60,
  paused: false,
  lease_expired: false,
  pending_commands: 0,
  unapplied_command_ids: [],
  samples: [
    {
      sequence: 1,
      row: {
        time_s: time,
        uplink: { cumulative_ideal_bits: 0 },
        downlink: { cumulative_ideal_bits: 0 },
      },
    },
  ],
  command_acks: [],
  next_sequence: 1,
  latest_sequence: 1,
  first_sequence: 1,
  gap: false,
  final_snapshot: null,
  error: null,
});

// A click during saved-session restoration must not invalidate its polling generation.
const restored = harness('saved-active');
let state = restored.render();
assert.equal(state.restoring, true);
assert.equal(restored.requests.length, 1);
assert.match(restored.requests[0].path, /saved-active/);
await state.start(config, 60);
assert.equal(restored.requests.length, 1, 'Start must wait for the saved session response');
restored.requests[0].resolve({ session: session('saved-active') });
await flush();
state = restored.render();
assert.equal(state.restoring, false);
assert.equal(state.active, true);
assert.equal(state.session.live_id, 'saved-active');
restored.poll();
assert.equal(
  restored.requests.length,
  2,
  'Restored polling must not be stranded by the rejected Start',
);
assert.match(restored.requests[1].path, /after_sequence=1/);

// An API restart loses server sessions. Keep the prefix, release active controls,
// clear the persisted ID and permit a new session instead of trapping the UI.
const prefix = state.snapshot;
assert(prefix, 'The actual received prefix is retained for inspection');
restored.requests[1].reject(
  new Error('LIVE session not found; history is local and session-scoped'),
);
await flush();
state = restored.render();
assert.equal(state.active, false);
assert.equal(state.restoring, false);
assert.equal(state.session, null);
assert.strictEqual(state.snapshot, prefix);
assert.equal(restored.storage.get('ssi-live-session'), undefined);
assert.match(state.error, /session not found/);
const starting = state.start(config, 100);
assert.equal(restored.requests.length, 3);
assert.equal(restored.requests[2].path, '/api/live');
assert.equal(restored.requests[2].options.method, 'POST');
restored.requests[2].resolve({ session: session('replacement') });
await starting;
state = restored.render();
assert.equal(state.active, true);
assert.equal(state.session.live_id, 'replacement');
assert.equal(restored.storage.get('ssi-live-session'), 'replacement');
assert.equal(state.pending, false);
assert.equal(state.error, '');
console.log(
  'LIVE lifecycle passed: restoration blocks new starts without killing polling; missing server sessions release controls, retain their prefix and allow a clean replacement.',
);

// A lost session must also release an in-flight control's pending flag. Its
// late failure must not clear or overwrite a newer Start request.
const racing = harness('old-control');
let raceState = racing.render();
racing.requests[0].resolve({ session: session('old-control') });
await flush();
raceState = racing.render();
const oldControl = raceState.control({ paused: true });
assert.equal(racing.requests[1].path, '/api/live/old-control/control');
assert.equal(racing.render().pending, true);
racing.poll();
racing.requests[2].reject(new Error('LIVE session not found; history is local and session-scoped'));
await flush();
raceState = racing.render();
assert.equal(raceState.active, false);
assert.equal(raceState.pending, false, 'A404 must release the abandoned control pending state');
const replacementStart = raceState.start(config, 100);
assert.equal(racing.requests[3].path, '/api/live');
assert.equal(racing.render().pending, true);
racing.requests[1].reject(new Error('old control failed after replacement began'));
await oldControl;
raceState = racing.render();
assert.equal(raceState.pending, true, 'Old control completion cannot release a new Start');
assert.equal(raceState.error, '', 'Old control failure cannot replace the new session status');
racing.requests[3].resolve({ session: session('new-control') });
await replacementStart;
raceState = racing.render();
assert.equal(raceState.session.live_id, 'new-control');
assert.equal(raceState.pending, false);
console.log(
  'LIVE in-flight control recovery passed:404 releases stale pending state and late old responses cannot mutate replacement requests.',
);
