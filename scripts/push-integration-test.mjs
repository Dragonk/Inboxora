#!/usr/bin/env node
// End-to-end check of the built-in ntfy transport through the public reverse
// proxy (frontend/nginx.conf).
//
//   PUSH_TEST_URL=http://127.0.0.1:8080 node scripts/push-integration-test.mjs
//
// The ntfy Android distributor refuses a base URL containing a path, so the
// supported public surface is the domain ORIGIN ("up" + 12 base62 topics plus
// ntfy's /v1 API); /push/ is kept as a compatibility alias. Both are exercised:
//   1. ntfy health
//   2. UnifiedPush discovery
//   3. WebSocket subscribe
//   4. opaque publish
//   5. payload must contain ONLY { type, eventId } — no mail data
//   6. non-"up" topics are denied (not a public topic server)
//   7. an ordinary SPA path is NOT proxied to ntfy
//   8. optional long idle (PUSH_TEST_IDLE_MS) proving the proxy keeps the socket
//
// No Android device is needed. Exits non-zero on the first failure.
const BASE = (process.env.PUSH_TEST_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const IDLE_MS = Number(process.env.PUSH_TEST_IDLE_MS || 0);
const PREFIXES = ['', '/push'];
const OTHER_TOPIC = 'not-a-unifiedpush-topic';
const EVENT = { type: 'mail.changed', eventId: 'ci-opaque-' + Date.now() };

const randomTopic = () => 'up' + Array.from({ length: 12 }, () =>
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('PASS: ' + msg);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(prefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}${prefix}/v1/health`);
      if (res.ok && (await res.json()).healthy === true) return;
    } catch { /* not up yet */ }
    await wait(500);
  }
  fail(`ntfy did not become healthy under ${prefix || '/'}/v1/health`);
}

async function publish(prefix, topic, payload) {
  const res = await fetch(`${BASE}${prefix}/${topic}?up=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) fail(`publish returned HTTP ${res.status} (${prefix || 'origin'})`);
  return res.json();
}

async function assertOpaqueDelivery(prefix, topic, { withIdle = false } = {}) {
  const wsUrl = BASE.replace(/^http/, 'ws') + `${prefix}/${topic}/ws`;
  const received = new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error(`no WebSocket message within 30s for ${wsUrl}`)), 30000);
    ws.addEventListener('open', async () => {
      try {
        await wait(300); // let ntfy register the subscription
        ws.__sentAt = Date.now();
        await publish(prefix, topic, EVENT);
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

  const { data, latencyMs } = await received;
  let payload;
  try { payload = JSON.parse(data.message); } catch { fail('delivered message is not JSON'); }
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== 'eventId,type') fail('payload keys are not exactly {type,eventId}: ' + keys.join(','));
  if (payload.type !== 'mail.changed' || payload.eventId !== EVENT.eventId) fail('payload values differ from what was sent');
  const raw = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ['@', 'subject', 'from', 'body', 'account']) {
    if (raw.includes(forbidden)) fail(`payload leaked forbidden content: "${forbidden}"`);
  }
  ok(`${prefix || 'origin'}: opaque event delivered over WebSocket in ${latencyMs} ms (only type+eventId)`);

  if (withIdle && IDLE_MS > 0) {
    const idleWs = new WebSocket(wsUrl);
    const latency = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket silent after ${IDLE_MS}ms idle`)), IDLE_MS + 30000);
      idleWs.addEventListener('open', () => setTimeout(async () => {
        idleWs.__sentAt = Date.now();
        await publish(prefix, topic, EVENT);
      }, IDLE_MS));
      idleWs.addEventListener('message', (e) => {
        let d; try { d = JSON.parse(String(e.data)); } catch { return; }
        if (d.event !== 'message') return;
        clearTimeout(timer); idleWs.close(); resolve(Date.now() - idleWs.__sentAt);
      });
      idleWs.addEventListener('close', () => reject(new Error('WebSocket closed during the idle window')));
    });
    ok(`${prefix || 'origin'}: socket survived ${IDLE_MS} ms idle; next event in ${latency} ms`);
  }
}

async function checkSuite(prefix, { withIdle = false } = {}) {
  const label = prefix || 'origin';
  const topic = randomTopic();

  await waitForHealth(prefix);
  ok(`${label}: ntfy healthy under ${prefix || ''}/v1/health`);

  const discovery = await fetch(`${BASE}${prefix}/${topic}?up=1`);
  if (!discovery.ok) fail(`${label}: UnifiedPush discovery returned HTTP ${discovery.status}`);
  if ((await discovery.json())?.unifiedpush?.version !== 1) fail(`${label}: discovery payload missing version 1`);
  ok(`${label}: UnifiedPush discovery responds`);

  const denied = await fetch(`${BASE}${prefix}/${OTHER_TOPIC}?up=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (denied.ok) fail(`${label}: a non-UnifiedPush topic was accepted (public topic server?)`);
  ok(`${label}: non-UnifiedPush topic denied (HTTP ${denied.status})`);

  await assertOpaqueDelivery(prefix, topic, { withIdle });

  // An ordinary SPA path must not be captured by the topic rule.
  const spa = await fetch(`${BASE}${prefix}/inboxora-not-a-topic`);
  const body = await spa.text();
  if (body.includes('"code":40401')) fail(`${label}: an ordinary path was proxied to ntfy`);
  ok(`${label}: ordinary path stays with the SPA (HTTP ${spa.status})`);
}

async function main() {
  for (const [index, prefix] of PREFIXES.entries()) {
    await checkSuite(prefix, { withIdle: index === 0 && IDLE_MS > 0 });
  }
  console.log('PUSH_INTEGRATION_TEST_PASS');
}

main().catch((err) => fail(err.message));
