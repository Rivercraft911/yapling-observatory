import assert from 'node:assert/strict';
import { api, APIError } from './api.ts';

const originalFetch = globalThis.fetch;
const replies = [];
globalThis.fetch = async () => {
  assert(replies.length, 'Every request must have an explicit response');
  return replies.shift();
};

try {
  const issues = [
    { type: 'extra_forbidden', loc: ['body', 'preset'], msg: 'Extra inputs are not permitted' },
    { type: 'value_error', loc: ['body', 'modes', 2], msg: 'Value error, unsupported mode' },
  ];
  replies.push(new Response(JSON.stringify({ detail: issues }), { status: 422 }));
  await assert.rejects(api('/api/mission/delivery-example'), (error) => {
    assert(error instanceof APIError);
    assert.equal(error.status, 422);
    assert.equal(
      error.message,
      'preset: Extra inputs are not permitted\nmodes.2: unsupported mode',
    );
    assert.deepEqual(error.issues, issues);
    return true;
  });

  replies.push(new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 }));
  await assert.rejects(api('/api/mission/demo/terminator'), (error) => {
    assert(error instanceof APIError);
    assert.equal(error.status, 404);
    assert.equal(error.message, 'Not Found');
    assert.deepEqual(error.issues, []);
    return true;
  });

  replies.push(new Response('temporarily unavailable', { status: 503 }));
  await assert.rejects(api('/api/health'), (error) => {
    assert(error instanceof APIError);
    assert.equal(error.status, 503);
    assert.equal(error.message, 'temporarily unavailable');
    return true;
  });

  replies.push(new Response(JSON.stringify({ scenario: { name: 'Current mission' } })));
  assert.deepEqual(await api('/api/mission/default'), { scenario: { name: 'Current mission' } });
  assert.equal(replies.length, 0);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(
  'API errors retain HTTP status and structured validation issues without changing response messages.',
);
