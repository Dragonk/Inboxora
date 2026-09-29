import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationRequestHeaders, conversationApi } from './conversationApi.ts';
import { CSRF_HEADER, CSRF_VALUE } from './api.ts';
import { getAuthEpoch, setAuthEpoch } from './authEpoch.ts';
import { queueReadStateMutation, pendingReadState, resetReadStateMutationsForTest } from './readStateMutation.ts';
import { queueStarStateMutation, pendingStarState, resetStarStateMutationsForTest } from './starStateMutation.ts';

afterEach(() => {
  mock.restoreAll();
  resetReadStateMutationsForTest();
  resetStarStateMutationsForTest();
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
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);

    await conversationApi.setStarred('conversation-1', true);
    await conversationApi.delete('conversation-1');

    assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
      ['/api/mail/conversations/conversation-1/star', 'POST'],
      ['/api/mail/conversations/conversation-1/delete', 'POST'],
    ]);
    for (const { init } of calls) {
      assert.equal(init.credentials, 'include');
      assert.equal(new Headers(init.headers).get(CSRF_HEADER), CSRF_VALUE);
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const detailSnapshot = (isRead = false, isStarred = false) => ({
  summary: { conversation_id: 'conversation' },
  logicalMessages: [{ id: 'logical', subject: 'Preserved subject', copies: [
    { id: 'copy', accountId: 'account', isRead, isStarred },
    { id: 'sibling', accountId: 'account', isRead: false, isStarred: false },
  ] }],
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('CE-only physical flag readback', () => {
  it('keeps read and star intents over an inflight stale detail response, without changing sibling copies', async () => {
    const writeResponse = deferred<unknown>();
    const read = queueReadStateMutation('copy', true, () => writeResponse.promise);
    const star = queueStarStateMutation('copy', true, () => writeResponse.promise);
    const detailResponse = deferred<Response>();
    mock.method(globalThis, 'fetch', () => detailResponse.promise);
    const oldReadback = conversationApi.detail('conversation');
    writeResponse.resolve({ pending: ['copy'] });
    await Promise.all([read.promise, star.promise]);
    detailResponse.resolve(json(detailSnapshot()));
    const data = await oldReadback;
    assert.equal(data.logicalMessages[0].id, 'logical');
    assert.equal(data.logicalMessages[0].subject, 'Preserved subject');
    const [copy, sibling] = data.logicalMessages[0].copies;
    assert.deepEqual([copy.isRead, copy.is_read, copy.isStarred, copy.is_starred], [true, true, true, true]);
    assert.deepEqual([sibling.id, sibling.isRead, sibling.isStarred], ['sibling', false, false]);
    assert.equal(pendingReadState('copy'), true);
    assert.equal(pendingStarState('copy'), true);
  });

  it('accepts opposite provider truth after settlement and does not hold an unknown result forever', async () => {
    await queueReadStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
    await queueStarStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
    mock.method(globalThis, 'fetch', async () => json(detailSnapshot()));
    const data = await conversationApi.detail('conversation');
    const copy = data.logicalMessages[0].copies[0];
    assert.deepEqual([copy.isRead, copy.is_read, copy.isStarred, copy.is_starred], [false, false, false, false]);
    assert.equal(pendingReadState('copy'), undefined);
    assert.equal(pendingStarState('copy'), undefined);
  });

  it('protects a newer intent from a detail request started before the click', async () => {
    const detailResponse = deferred<Response>();
    mock.method(globalThis, 'fetch', () => detailResponse.promise);
    const oldReadback = conversationApi.detail('conversation');
    await queueReadStateMutation('copy', false, async () => ({ pending: ['copy'] })).promise;
    await queueStarStateMutation('copy', true, async () => ({ ok: true })).promise;
    detailResponse.resolve(json(detailSnapshot(true, false)));
    const copy = (await oldReadback).logicalMessages[0].copies[0];
    assert.deepEqual([copy.isRead, copy.isStarred], [false, true]);
    assert.equal(pendingReadState('copy'), false);
  });

  it('does not reconcile or project another session using an old detail response', async () => {
    const detailResponse = deferred<Response>();
    mock.method(globalThis, 'fetch', () => detailResponse.promise);
    const oldReadback = conversationApi.detail('conversation');
    setAuthEpoch(getAuthEpoch() + 1);
    await queueReadStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
    await queueStarStateMutation('copy', true, async () => ({ pending: ['copy'] })).promise;
    const snapshot = detailSnapshot();
    detailResponse.resolve(json(snapshot));
    assert.deepEqual(await oldReadback, snapshot);
    assert.equal(pendingReadState('copy'), true);
    assert.equal(pendingStarState('copy'), true);
  });

  it('preserves absent copy/flag metadata instead of inventing a readback', async () => {
    const snapshot = { logicalMessages: [{ id: 'no-copies' }, { id: 'unknown', copies: [{ subject: 'No identity' }, { id: 'copy' }] }] };
    await queueReadStateMutation('unrelated', true, async () => ({ pending: ['unrelated'] })).promise;
    mock.method(globalThis, 'fetch', async () => json(snapshot));
    assert.deepEqual(await conversationApi.detail('conversation'), snapshot);
    assert.equal(pendingReadState('unrelated'), true);
  });
});
