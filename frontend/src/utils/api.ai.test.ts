import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE, streamAiChat } from './api.ts';

afterEach(() => {
  mock.restoreAll();
});

describe('ChatGPT authorization API', () => {
  it('uses the admin Codex lifecycle routes with CSRF-aware requests', async () => {
    const calls = [];
    const fetchStub = async (url: string, init: RequestInit) => {
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
    let request;
    const fetchStub = async (url: string, init: RequestInit) => {
      request = { url, init };
      return new Response([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    mock.method(globalThis, 'fetch', fetchStub);
    const updates = [];

    await assert.doesNotReject(async () => {
      const text = await streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (value: unknown) => updates.push(value),
      });
      assert.equal(text, 'Hello world');
    });
    assert.equal(request.url, '/api/ai/chat');
    assert.equal(request.init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(request.init.body, JSON.stringify({
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
    const updates = [];

    await assert.rejects(
      streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (text) => updates.push(text),
      }),
      /AI request failed/,
    );
    assert.deepEqual(updates, ['Partial']);
  });
});
