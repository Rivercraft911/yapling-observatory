import assert from 'node:assert/strict';
import { MissionRequests, canAdvanceMissionRun } from './missionRequests.ts';
import {
  MAX_MISSION_ARCHIVE_BYTES,
  importMissionArchive,
  prepareMissionArchive,
  readMissionArchive,
  requestMissionRun,
} from './missionArchives.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const applyWhenCurrent = async (request, result, apply) => {
  const value = await result;
  if (request.current()) apply(value);
};

// Input edits cancel opening without losing the edit or prior history, even if an adapter ignores abort.
{
  const requests = new MissionRequests();
  const state = { draft: 'old inputs', history: 'valid history' };
  const result = deferred();
  const opening = requests.beginImport();
  const pending = applyWhenCurrent(opening, result.promise, (value) => Object.assign(state, value));
  requests.inputsChanged();
  state.draft = 'new edit';
  result.resolve({ draft: 'archive inputs', history: 'archive history' });
  await pending;
  assert.deepEqual(state, { draft: 'new edit', history: 'valid history' });
  assert.equal(opening.signal.aborted, true);
}

// A failed Open cannot allow earlier defaults or orbit responses to overwrite the retained draft.
{
  const requests = new MissionRequests();
  let draft = 'dirty draft';
  const defaults = deferred(),
    orbit = deferred();
  const defaultRequest = requests.begin('defaults'),
    orbitRequest = requests.begin('orbit');
  const old = [
    applyWhenCurrent(defaultRequest, defaults.promise, (value) => {
      draft = value;
    }),
    applyWhenCurrent(orbitRequest, orbit.promise, (value) => {
      draft = value;
    }),
  ];
  const opening = requests.beginImport();
  await assert.rejects(
    applyWhenCurrent(opening, Promise.reject(new Error('bad checksum')), () => {
      draft = 'invalid';
    }),
    /bad checksum/,
  );
  defaults.resolve('late defaults');
  orbit.resolve('late orbit');
  await Promise.all(old);
  assert.equal(draft, 'dirty draft');
}

// A newer file wins independently of which validation request returns first.
{
  const requests = new MissionRequests();
  let history = 'old';
  const first = deferred(),
    second = deferred();
  const a = applyWhenCurrent(requests.beginImport(), first.promise, (value) => {
    history = value;
  });
  const b = applyWhenCurrent(requests.beginImport(), second.promise, (value) => {
    history = value;
  });
  second.resolve('second archive');
  await b;
  first.resolve('first archive');
  await a;
  assert.equal(history, 'second archive');
}

// Draft edits remain independent of owned worker history; opening later invalidates every stale worker callback.
{
  const requests = new MissionRequests();
  const run = requests.begin('run'),
    poll = requests.begin('poll'),
    cancel = requests.begin('cancel');
  requests.inputsChanged();
  assert.ok(run.current() && poll.current() && cancel.current());
  const opening = requests.beginImport();
  assert.ok(!run.current() && !poll.current() && !cancel.current() && opening.current());
  requests.cancelAll();
  assert.equal(opening.current(), false);
}

for (const status of ['complete', 'failed', 'cancelled'])
  assert.equal(
    canAdvanceMissionRun({ run_id: 'same', status }, { run_id: 'same', status: 'cancelling' }),
    false,
  );
assert.equal(
  canAdvanceMissionRun(
    { run_id: 'same', status: 'cancelling' },
    { run_id: 'same', status: 'running' },
  ),
  false,
);
assert.equal(
  canAdvanceMissionRun(
    { run_id: 'same', status: 'running' },
    { run_id: 'same', status: 'complete' },
  ),
  true,
);
assert.equal(
  canAdvanceMissionRun({ run_id: 'old', status: 'complete' }, { run_id: 'new', status: 'queued' }),
  true,
);

// Transport preserves numerical lexical forms for checksums and source identity, including negative zero.
{
  const originalFetch = globalThis.fetch;
  const signal = new AbortController().signal;
  const rawRun =
    '{"run_id":"source","status":"complete","result":{"manifest":{"scenario":{"q":[1.0,-0.0]}}}}';
  const archive = '{"format":"ssi-coupled-mission","number":1.0,"negative":-0.0}';
  try {
    globalThis.fetch = async () => new Response(rawRun, { status: 200 });
    const captured = await requestMissionRun('/run');
    assert.equal(captured.text, rawRun);
    assert.notEqual(JSON.stringify(captured.run), rawRun);
    const snapshot = Object.freeze({
      scenario: Object.freeze({ name: 'archived inputs' }),
      run: captured.run,
      raw_run_json: captured.text,
    });
    const dirtyDraft = { name: 'new unrun inputs' };
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = init.body;
      return new Response(archive, { status: 200 });
    };
    assert.equal(await prepareMissionArchive(snapshot, signal), archive);
    assert.equal(sent, rawRun);
    assert.equal(dirtyDraft.name, 'new unrun inputs');

    globalThis.fetch = async (_url, init) => {
      sent = init.body;
      return new Response('{"snapshot":{},"import_metadata":{}}', { status: 200 });
    };
    await importMissionArchive(archive, signal);
    assert.equal(sent, archive);

    globalThis.fetch = async () => {
      throw new Error('Service/cache unavailable');
    };
    assert.equal(
      await prepareMissionArchive(
        { ...snapshot, imported: {}, original_archive_json: archive },
        signal,
      ),
      archive,
    );
    await assert.rejects(
      prepareMissionArchive({ ...snapshot, raw_run_json: undefined }, signal),
      /predates archive capture/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Oversize files never enter the reader; cancelled reads never reach validation.
{
  const signal = new AbortController().signal;
  let read = false;
  await assert.rejects(
    readMissionArchive(
      {
        size: MAX_MISSION_ARCHIVE_BYTES + 1,
        text: async () => {
          read = true;
          return '';
        },
      },
      signal,
    ),
    /64 MiB/,
  );
  assert.equal(read, false);
  await assert.rejects(readMissionArchive({ size: 0, text: async () => '' }, signal), /empty/);
  const content = deferred();
  const abort = new AbortController();
  const pending = readMissionArchive({ size: 4, text: () => content.promise }, abort.signal);
  abort.abort();
  content.resolve('null');
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(await readMissionArchive({ size: 5, text: async () => '{bad}' }, signal), '{bad}');
}
console.log(
  'Mission request races passed: edited inputs, failed/replaced imports, stale default/orbit/worker replies, cleanup and terminal cancellation ordering.',
);
console.log(
  'Archive transport passed: exact raw run/archive text, negative zero, dirty-draft independence, cache-independent imported saves, bounded and cancelled reads.',
);
