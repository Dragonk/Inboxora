// Real PostgreSQL, real push device registry + real native (device-token) auth.
// No external push provider is contacted: registration only stores the endpoint.
//
// Run against a migrated scratch database:
//   DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=inboxora_test \
//   DB_USER=... DB_PASSWORD=... \
//   ENCRYPTION_KEY=<64 hex> REQUIRE_PUSH_POSTGRES=1 npx vitest run src/routes/push.integration.test.js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import express from 'express';
import 'express-async-errors';
import { pool, query } from '../services/db.js';
import pushRouter from './push.js';
import { buildMailNotificationEvent } from '../services/mailNotificationEvent.js';
import { dispatchMailNotification, resetDispatchDedup } from '../services/pushDispatcher.js';

const enabled = process.env.REQUIRE_PUSH_POSTGRES === '1';

describe.skipIf(!enabled)('push device registry with PostgreSQL', () => {
  let server;
  let base;
  let ownerId;
  let otherId;
  const sessions = { userId: null };

  beforeAll(async () => {
    ownerId = randomUUID();
    otherId = randomUUID();
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3),($4,$5,$6)', [
      ownerId, `push-owner-${ownerId}`, 'unused',
      otherId, `push-other-${otherId}`, 'unused',
    ]);

    const app = express();
    app.use(express.json());
    // The management routes are session-authenticated; inject a synthetic session.
    app.use('/api/push', (req, _res, next) => { req.session = { userId: sessions.userId }; next(); });
    app.use('/api/push', pushRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (ownerId) await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ownerId, otherId].filter(Boolean)]);
    await pool.end();
  });

  async function register(deviceId, endpoint = 'https://distributor.example/up/topic') {
    const response = await fetch(`${base}/api/push/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, platform: 'android', transport: 'unifiedpush', endpoint, appVersion: '4.0.0' }),
    });
    return { response, body: await response.json() };
  }

  it('registers, encrypts the endpoint, and authenticates the native API with the issued token', async () => {
    sessions.userId = ownerId;
    const { response, body } = await register('device-1');
    expect(response.status).toBe(201);
    expect(body.deviceToken).toMatch(/^mf_push_[0-9a-f-]{36}\./);

    const stored = (await query('SELECT endpoint, token_hash FROM push_devices WHERE user_id=$1 AND device_id=$2', [ownerId, 'device-1'])).rows[0];
    expect(stored.endpoint.startsWith('enc:v1:')).toBe(true);
    expect(stored.endpoint).not.toContain('distributor.example');
    expect(stored.token_hash).not.toContain(body.deviceToken);

    // The device token authenticates the native background API.
    const native = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${body.deviceToken}` } });
    expect(native.status).toBe(200);
    expect(await native.json()).toEqual({ message: null, eventId: null, unreadCount: 0 });

    const wrong = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: 'Bearer mf_push_00000000-0000-0000-0000-000000000000.nope' } });
    expect(wrong.status).toBe(401);
  });

  it('rotates the device token on re-registration and invalidates the previous one', async () => {
    sessions.userId = ownerId;
    const first = await register('device-1');
    const second = await register('device-1');
    expect(second.body.deviceToken).not.toBe(first.body.deviceToken);

    const stale = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${first.body.deviceToken}` } });
    expect(stale.status).toBe(401);

    // One row per (user, device): an upsert, not a duplicate.
    const count = (await query('SELECT COUNT(*)::int AS n FROM push_devices WHERE user_id=$1 AND device_id=$2', [ownerId, 'device-1'])).rows[0].n;
    expect(count).toBe(1);
  });

  it('keeps devices isolated between users (no cross-account read or delete)', async () => {
    sessions.userId = ownerId;
    const ownerDevice = await register('owner-device');
    sessions.userId = otherId;
    const otherDevice = await register('other-device');

    // The other user cannot see the owner's device in their list.
    const list = await (await fetch(`${base}/api/push/devices`)).json();
    expect(list.devices.map((device) => device.deviceId)).not.toContain('owner-device');

    // ... nor delete it by id.
    const crossDelete = await fetch(`${base}/api/push/devices/owner-device`, { method: 'DELETE' });
    expect(crossDelete.status).toBe(404);
    expect((await query('SELECT COUNT(*)::int AS n FROM push_devices WHERE user_id=$1 AND device_id=$2', [ownerId, 'owner-device'])).rows[0].n).toBe(1);

    // Each token resolves to its own user only.
    const ownerNative = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${ownerDevice.body.deviceToken}` } });
    const otherNative = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${otherDevice.body.deviceToken}` } });
    expect(ownerNative.status).toBe(200);
    expect(otherNative.status).toBe(200);
  });

  it('unregisters this device on logout and leaves sibling devices alone', async () => {
    sessions.userId = ownerId;
    const phone = await register('logout-phone');
    await register('logout-tablet');

    const removed = await fetch(`${base}/api/push/devices/logout-phone`, { method: 'DELETE' });
    expect(removed.status).toBe(200);

    const stale = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${phone.body.deviceToken}` } });
    expect(stale.status).toBe(401);

    const remaining = (await query('SELECT device_id FROM push_devices WHERE user_id=$1 ORDER BY device_id', [ownerId])).rows.map((row) => row.device_id);
    expect(remaining).toContain('logout-tablet');
    expect(remaining).not.toContain('logout-phone');
  });

  it('persists subscriptions across a server restart (rows survive, not just memory)', async () => {
    sessions.userId = ownerId;
    const registered = await register('restart-device');
    // A fresh read of the row, as a new process would do, still authenticates.
    const native = await fetch(`${base}/api/push/native/inbox`, { headers: { authorization: `Bearer ${registered.body.deviceToken}` } });
    expect(native.status).toBe(200);
    expect((await query('SELECT COUNT(*)::int AS n FROM push_devices WHERE user_id=$1 AND device_id=$2', [ownerId, 'restart-device'])).rows[0].n).toBe(1);
  });

  it('delivers only the opaque event to a UnifiedPush endpoint (mock distributor)', async () => {
    sessions.userId = ownerId;
    const received = [];
    const mock = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ url: req.url, method: req.method, body });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const port = mock.address().port;

    const previous = process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS;
    process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS = 'true';
    try {
      const { response, body } = await register('opaque-device', `http://127.0.0.1:${port}/upMOCKTOPIC123?up=1`);
      expect(response.status).toBe(201);
      expect(body.deviceToken).toMatch(/^mf_push_/);

      resetDispatchDedup();
      const event = buildMailNotificationEvent({
        userId: ownerId,
        message: {
          id: randomUUID(),
          account_id: randomUUID(),
          folder: 'INBOX',
          fromName: 'Ada Lovelace',
          fromEmail: 'ada@example.com',
          subject: 'Top secret subject',
        },
        alertCount: 1,
      });

      const summary = await dispatchMailNotification(event);
      expect(summary.native.delivered).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('POST');
      expect(received[0].url).toBe('/upMOCKTOPIC123?up=1');
      // Exactly the opaque event — no sender, subject, address or body.
      expect(JSON.parse(received[0].body)).toEqual({ type: 'mail.changed', eventId: event.eventId });
      expect(received[0].body).not.toContain('Ada');
      expect(received[0].body).not.toContain('Top secret');
      expect(received[0].body).not.toContain('ada@example.com');
    } finally {
      if (previous === undefined) delete process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS;
      else process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS = previous;
      await new Promise((resolve) => mock.close(resolve));
      await query('DELETE FROM push_devices WHERE user_id=$1 AND device_id=$2', [ownerId, 'opaque-device']);
    }
  });
});

