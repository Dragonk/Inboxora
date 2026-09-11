#!/usr/bin/env node
// End-to-end check of the built-in ntfy transport through the public /push path.
//
//   PUSH_TEST_URL=http://127.0.0.1:8080 node scripts/push-integration-test.mjs
//
// It exercises the real reverse proxy (frontend/nginx.conf) and a real ntfy:
//   1. ntfy health
//   2. UnifiedPush discovery  GET  /push/<up-topic>?up=1
//   3. WebSocket subscribe    WS   /push/<up-topic>/ws
//   4. opaque publish         POST /push/<up-topic>?up=1
//   5. payload must contain ONLY { type, eventId } — no mail data
//   6. non-"up" topics are denied (not a public topic server)
//   7. optional long idle (PUSH_TEST_IDLE_MS) proving the proxy keeps the socket
//
// No Android device is needed. Exits non-zero on the first failure.
const BASE = (process.env.PUSH_TEST_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const IDLE_MS = Number(process.env.PUSH_TEST_IDLE_MS || 0);
const TOPIC = 'up' + Array.from({ length: 12 }, () =>
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
const OTHER_TOPIC = 'not-a-unifiedpush-topic';
const EVENT = { type: 'mail.changed', eventId: 'ci-opaque-' + Date.now() };

const wsUrl = BASE.replace(/^http/, 'ws') + `/push/${TOPIC}/ws`;
const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('PASS: ' + msg);

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/push/v1/health`);
      if (res.ok && (await res.json()).healthy === true) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('ntfy did not become healthy under /push');
}

async function publish(payload) {
  const res = await fetch(`${BASE}/push/${TOPIC}?up=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) fail(`publish returned HTTP ${res.status}`);
  return res.json();
}

const received = new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => reject(new Error('no WebSocket message within 30s')), 30000);
  ws.addEventListener('open', async () => {
    try {
      await new Promise((r) => setTimeout(r, 300)); // let ntfy register the subscription
      const sentAt = Date.now();
      await publish(EVENT);
      ws.__sentAt = sentAt;
    } catch (err) { reject(err); }
  });
  ws.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    if (data.event !== 'message') return;
    clearTimeout(timer);
    ws.close();
    resolve({ data, latencyMs: Date.now() - (ws.__sentAt || Date.now()) });
  });
  ws.addEventListener('error', () => reject(new Error(`WebSocket error for ${wsUrl}`)));
});

async function main() {
  await waitForHealth();
  ok('ntfy healthy under /push');

  const discovery = await fetch(`${BASE}/push/${TOPIC}?up=1`);
  if (!discovery.ok) fail(`UnifiedPush discovery returned HTTP ${discovery.status}`);
  const version = await discovery.json();
  if (version?.unifiedpush?.version !== 1) fail('UnifiedPush discovery payload missing version 1');
  ok('UnifiedPush discovery responds under /push');

  const denied = await fetch(`${BASE}/push/${OTHER_TOPIC}?up=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (denied.ok) fail('a non-UnifiedPush topic was accepted (public topic server?)');
  ok(`non-UnifiedPush topic denied (HTTP ${denied.status})`);

  const { data, latencyMs } = await received;
  let payload;
  try { payload = JSON.parse(data.message); } catch { fail('delivered message is not JSON'); }
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== 'eventId,type') fail('payload keys are not exactly {type,eventId}: ' + keys.join(','));
  if (payload.type !== 'mail.changed' || payload.eventId !== EVENT.eventId) fail('payload values differ from what was sent');
  const raw = JSON.stringify(payload);
  for (const forbidden of ['@', 'subject', 'from', 'body', 'account']) {
    if (raw.toLowerCase().includes(forbidden)) fail(`payload leaked forbidden content: "${forbidden}"`);
  }
  ok(`opaque event delivered over /push WebSocket in ${latencyMs} ms (only type+eventId)`);

  if (IDLE_MS > 0) {
    const ws = new WebSocket(wsUrl);
    const second = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket closed or silent after ${IDLE_MS}ms idle`)), IDLE_MS + 30000);
      ws.addEventListener('open', () => setTimeout(async () => {
        ws.__sentAt = Date.now();
        await publish(EVENT);
      }, IDLE_MS));
      ws.addEventListener('message', (e) => {
        let d; try { d = JSON.parse(String(e.data)); } catch { return; }
        if (d.event !== 'message') return;
        clearTimeout(timer); ws.close(); resolve(Date.now() - ws.__sentAt);
      });
      ws.addEventListener('close', () => reject(new Error('WebSocket closed during the idle window')));
    });
    const latency = await second;
    ok(`socket survived ${IDLE_MS} ms idle; next event delivered in ${latency} ms`);
  }

  console.log('PUSH_INTEGRATION_TEST_PASS');
}

main().catch((err) => fail(err.message));
