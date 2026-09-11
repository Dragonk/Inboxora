import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function worker(matchAll) {
  const listeners = {}, shown = [], sent = [];
  const self = { addEventListener: (type, listener) => { listeners[type] = listener; },
    registration: { showNotification: async (...args) => shown.push(args) }, clients: { matchAll }, navigator: {},
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, fetch: async (...args) => { sent.push(args); return { ok: true }; } });
  return { listeners, shown, sent };
}
test('push displays with no app window and even when enumerating clients fails', async () => {
  const { listeners, shown } = worker(async () => { throw new Error('No client process'); });
  let done;
  listeners.push({ data: { json: () => ({ title: 'Synthetic mail', body: 'Details' }) }, waitUntil: p => { done = p; } });
  await done;
  assert.equal(shown.length, 1); assert.equal(shown[0][0], 'Synthetic mail');
});
test('push notifies open app windows so a stale websocket is not the only refresh path', async () => {
  const messages = [];
  const { listeners } = worker(async () => [{ postMessage: data => messages.push(data) }]);
  let done;
  listeners.push({ data: { json: () => ({ title: 'Synthetic mail' }) }, waitUntil: p => { done = p; } });
  await done; assert.equal(messages[0].type, 'inboxora_mail_changed');
});
test('subscription renewal persists the new endpoint without an open settings page', async () => {
  const { listeners, sent } = worker(async () => []);
  let done;
  listeners.pushsubscriptionchange({ newSubscription: { toJSON: () => ({ endpoint: 'https://push.example.test/new' }) }, waitUntil: p => { done = p; } });
  await done;
  assert.equal(sent[0][0], '/api/auth/push/subscribe');
  assert.equal(sent[0][1].headers['X-Requested-With'], 'MailFlow');
});
