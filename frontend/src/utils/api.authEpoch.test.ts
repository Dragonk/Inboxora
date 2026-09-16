import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { api } from './api.ts';
import { setAuthEpoch } from './authEpoch.ts';

const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const events: string[] = [];

class TestCustomEvent extends Event {
  constructor(type: string) { super(type); }
}

function installWindow() {
  events.length = 0;
  Reflect.set(globalThis, 'window', { dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
  Reflect.set(globalThis, 'CustomEvent', TestCustomEvent);
}

afterEach(() => {
  mock.restoreAll();
  Reflect.set(globalThis, 'window', originalWindow);
  Reflect.set(globalThis, 'CustomEvent', originalCustomEvent);
  setAuthEpoch(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('late 401 and 423 responses do not emit global auth events for a newer session', async () => {
  installWindow();
  for (const [status, event] of [[401, 'inboxora:session_expired'], [423, 'inboxora:locked']] as const) {
    setAuthEpoch(1);
    const response = deferred<{ ok: boolean; status: number; json: () => Promise<{ error: string }> }>();
    mock.method(globalThis, 'fetch', async () => response.promise);
    const request = api.getMessages({});
    setAuthEpoch(2);
    response.resolve({ ok: false, status, json: async () => ({ error: 'late response' }) });
    await assert.rejects(request);
    assert.ok(!events.includes(event));
    mock.restoreAll();
  }
});

test('current-session 401 and 423 responses retain global auth events', async () => {
  installWindow();
  for (const [status, event] of [[401, 'inboxora:session_expired'], [423, 'inboxora:locked']] as const) {
    setAuthEpoch(status);
    mock.method(globalThis, 'fetch', async () => ({ ok: false, status, json: async () => ({ error: 'current response' }) }));
    await assert.rejects(api.getMessages({}));
    assert.ok(events.includes(event));
    mock.restoreAll();
  }
});
