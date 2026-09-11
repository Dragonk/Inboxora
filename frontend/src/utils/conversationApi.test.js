import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationRequestHeaders, conversationApi } from './conversationApi.js';
import { CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Conversation Engine API client', () => {
  it('does not let call-specific headers override the mandatory CSRF contract', () => {
    const headers = buildConversationRequestHeaders({
      'x-requested-with': 'untrusted-value',
      'X-Trace-Id': 'trace-123',
    });

    assert.equal(headers.get(CSRF_HEADER), CSRF_VALUE);
    assert.equal(headers.get('x-requested-with'), CSRF_VALUE);
    assert.equal(headers.get('X-Trace-Id'), 'trace-123');
  });

  it('preserves non-CSRF headers from every standard HeadersInit shape', () => {
    const fromHeaders = buildConversationRequestHeaders(new Headers([
      ['x-requested-with', 'untrusted-value'],
      ['X-Trace-Id', 'trace-from-headers'],
    ]));
    const fromTuples = buildConversationRequestHeaders([
      ['X-REQUESTED-WITH', 'untrusted-value'],
      ['X-Trace-Id', 'trace-from-tuples'],
    ]);

    assert.equal(fromHeaders.get(CSRF_HEADER), CSRF_VALUE);
    assert.equal(fromHeaders.get('X-Trace-Id'), 'trace-from-headers');
    assert.equal(fromTuples.get(CSRF_HEADER), CSRF_VALUE);
    assert.equal(fromTuples.get('X-Trace-Id'), 'trace-from-tuples');
  });

  it('sends authenticated CSRF-aware requests for destructive and state-changing actions', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await conversationApi.setStarred('conversation-1', true);
    await conversationApi.delete('conversation-1');

    assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
      ['/api/mail/conversations/conversation-1/star', 'POST'],
      ['/api/mail/conversations/conversation-1/delete', 'POST'],
    ]);
    for (const { init } of calls) {
      assert.equal(init.credentials, 'include');
      assert.equal(init.headers.get(CSRF_HEADER), CSRF_VALUE);
      assert.equal(init.headers.get('Content-Type'), 'application/json');
    }
  });
});
