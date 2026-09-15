import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE, streamAiChat } from './api.ts';

/** A fetch init as the API client builds it: a plain header record plus method/body. */
type CapturedInit = Pick<RequestInit, 'method' | 'body'> & { headers: Record<string, string> };
/** One request observed by the fetch stub. */
type CapturedRequest = { url: string; init: CapturedInit };

afterEach(() => {
  mock.restoreAll();
});

describe('ChatGPT authorization API', () => {
  it('uses the admin Codex lifecycle routes with CSRF-aware requests', async () => {
    const calls: [string, CapturedInit][] = [];
    const fetchStub = async (url: string, init: CapturedInit) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);

    await api.ai.codex.start();
    await api.ai.codex.poll('flow-123');
    await api.ai.codex.status();
    await api.ai.codex.cancel('flow-123');
    await api.ai.codex.disconnect();

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/admin/ai/codex/device', 'POST'],
      ['/api/admin/ai/codex/device/poll', 'POST'],
      ['/api/admin/ai/codex/status', 'GET'],
      ['/api/admin/ai/codex/device', 'DELETE'],
      ['/api/admin/ai/codex', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[1][1].body, JSON.stringify({ flowId: 'flow-123' }));
    assert.equal(calls[3][1].body, JSON.stringify({ flowId: 'flow-123' }));
  });

  it('streams AI text deltas through the shared API client', async () => {
    const requests: CapturedRequest[] = [];
    const fetchStub = async (url: string, init: CapturedInit) => {
      requests.push({ url, init });
      return new Response([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    mock.method(globalThis, 'fetch', fetchStub);
    const updates: unknown[] = [];

    await assert.doesNotReject(async () => {
      const text = await streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (value: unknown) => updates.push(value),
      });
      assert.equal(text, 'Hello world');
    });
    assert.equal(requests[0].url, '/api/ai/chat');
    assert.equal(requests[0].init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(requests[0].init.body, JSON.stringify({
      messages: [{ role: 'user', content: 'Draft a reply' }],
    }));
    assert.deepEqual(updates, ['Hello ', 'Hello world']);
  });

  it('rejects streamed error frames instead of completing partial output', async () => {
    const fetchStub = async () => new Response([
      'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
      'data: {"error":"AI request failed"}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    mock.method(globalThis, 'fetch', fetchStub);
    const updates: string[] = [];

    await assert.rejects(
      streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (text) => updates.push(text),
      }),
      /AI request failed/,
    );
    assert.deepEqual(updates, ['Partial']);
  });
});
