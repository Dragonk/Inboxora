import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices,
  transportStatus, query, validateHost,
} = vi.hoisted(() => ({
  listPushDevices: vi.fn(),
  registerPushDevice: vi.fn(),
  removePushDevice: vi.fn(),
  removeAllPushDevices: vi.fn(),
  pruneStalePushDevices: vi.fn(),
  transportStatus: vi.fn(),
  query: vi.fn(),
  validateHost: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../middleware/deviceAuth.js', () => ({
  requireDeviceAuth: (req, _res, next) => { req.pushDevice = { id: 'row-1', userId: 'user-1', deviceId: 'device-1' }; next(); },
}));
vi.mock('../services/pushDevices.js', () => ({
  listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices,
}));
vi.mock('../services/pushTransports.js', () => ({ transportStatus }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: true }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/hostValidation.js', () => ({ validateHost }));

import express from 'express';
import pushRouter from './push.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  for (const fn of [listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices, transportStatus, query, validateHost]) fn.mockReset();
  pruneStalePushDevices.mockResolvedValue(0);
  transportStatus.mockReturnValue({ unifiedpush: true, fcm: false });
  validateHost.mockResolvedValue(null);
});

describe('POST /api/push/devices', () => {
  it('registers for the session user and returns the device token exactly once', async () => {
    registerPushDevice.mockResolvedValue({
      device: { id: 'row-1', device_id: 'device-1', platform: 'android', transport: 'unifiedpush', app_version: '4.0.0', created_at: 'now', updated_at: 'now', last_seen: 'now' },
      deviceToken: 'mf_push_11111111-2222-3333-4444-555555555555.secret',
    });

    const response = await fetch(`${base}/api/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1', platform: 'android', transport: 'unifiedpush', endpoint: 'https://ntfy.example.com/up/abc', appVersion: '4.0.0' }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.deviceToken).toBe('mf_push_11111111-2222-3333-4444-555555555555.secret');
    // The user id comes from the session, never the request body.
    expect(registerPushDevice).toHaveBeenCalledWith('user-1', expect.objectContaining({ deviceId: 'device-1' }));
    expect(body.device.endpoint).toBeUndefined();
  });

  it('rejects a non-HTTPS or private UnifiedPush endpoint (SSRF guard)', async () => {
    const plaintext = await fetch(`${base}/api/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd', platform: 'android', transport: 'unifiedpush', endpoint: 'http://ntfy.local/up' }),
    });
    expect(plaintext.status).toBe(400);
    expect(registerPushDevice).not.toHaveBeenCalled();

    validateHost.mockResolvedValue('Host resolves to a private or reserved IP address');
    const privateHost = await fetch(`${base}/api/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd', platform: 'android', transport: 'unifiedpush', endpoint: 'https://rebind.example.com/up' }),
    });
    expect(privateHost.status).toBe(400);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it('maps service validation errors to 400', async () => {
    registerPushDevice.mockRejectedValue(Object.assign(new Error('Unsupported platform'), { statusCode: 400 }));
    const response = await fetch(`${base}/api/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd', platform: 'android', transport: 'fcm', endpoint: 'token' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('device management', () => {
  it('lists only metadata for the caller devices', async () => {
    listPushDevices.mockResolvedValue([{ id: 'row-1', device_id: 'device-1', platform: 'android', transport: 'fcm', app_version: '4.0.0', created_at: 'a', updated_at: 'b', last_seen: 'c', disabled_at: null }]);
    const response = await fetch(`${base}/api/push/devices`);
    const body = await response.json();
    expect(listPushDevices).toHaveBeenCalledWith('user-1');
    expect(body.devices[0]).toEqual({ id: 'row-1', deviceId: 'device-1', platform: 'android', transport: 'fcm', appVersion: '4.0.0', createdAt: 'a', updatedAt: 'b', lastSeen: 'c', disabled: false });
    expect(JSON.stringify(body)).not.toMatch(/endpoint|token/i);
  });

  it('unregisters a device scoped to the caller and 404s another user device', async () => {
    removePushDevice.mockResolvedValueOnce({ id: 'row-1', device_id: 'device-1' });
    const ok = await fetch(`${base}/api/push/devices/device-1`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(removePushDevice).toHaveBeenCalledWith('user-1', 'device-1');

    removePushDevice.mockResolvedValueOnce(null);
    const other = await fetch(`${base}/api/push/devices/device-of-someone-else`, { method: 'DELETE' });
    expect(other.status).toBe(404);
  });

  it('removes every device on logout', async () => {
    removeAllPushDevices.mockResolvedValue(2);
    const response = await fetch(`${base}/api/push/devices`, { method: 'DELETE' });
    expect(await response.json()).toEqual({ ok: true, removed: 2 });
    expect(removeAllPushDevices).toHaveBeenCalledWith('user-1');
  });

  it('reports transport availability without leaking device secrets', async () => {
    query.mockResolvedValue({ rows: [{ total: 2, active: 1 }] });
    const response = await fetch(`${base}/api/push/status`);
    const body = await response.json();
    expect(body).toEqual({ webPushConfigured: true, nativeTransports: { unifiedpush: true, fcm: false }, devices: { total: 2, active: 1 } });
  });
});

describe('native background API', () => {
  const EVENT_ID = '11111111-1111-1111-1111-111111111111';

  it('returns notification details for an owned message', async () => {
    query.mockImplementation((sql) => {
      if (sql.includes('COUNT(*)::int AS total')) return Promise.resolve({ rows: [{ total: 5 }] });
      return Promise.resolve({ rows: [{ id: EVENT_ID, subject: 'Hello', from_name: 'Ada', from_email: 'ada@example.com', account_id: 'acct-1', folder: 'INBOX' }] });
    });
    const response = await fetch(`${base}/api/push/native/messages/${EVENT_ID}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      eventId: EVENT_ID,
      message: { messageId: EVENT_ID, accountId: 'acct-1', folder: 'INBOX', title: 'Ada', body: 'Hello' },
      unreadCount: 5,
    });
    // Ownership is enforced in SQL against the device's user.
    expect(query.mock.calls[0][1]).toEqual([EVENT_ID, 'user-1']);
  });

  it('404s a message that belongs to another user', async () => {
    query.mockResolvedValue({ rows: [] });
    const response = await fetch(`${base}/api/push/native/messages/${EVENT_ID}`);
    expect(response.status).toBe(404);
  });

  it('rejects a malformed message id before touching the database', async () => {
    const response = await fetch(`${base}/api/push/native/messages/not-a-uuid`);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the reconciliation snapshot for the fallback worker', async () => {
    query.mockImplementation((sql) => {
      if (sql.includes('ORDER BY m.date')) return Promise.resolve({ rows: [{ id: 'msg-9', subject: 'Latest', from_name: '', from_email: 'bob@example.com', account_id: 'acct-1', folder: 'INBOX' }] });
      return Promise.resolve({ rows: [{ total: 2 }] });
    });
    const response = await fetch(`${base}/api/push/native/inbox`);
    const body = await response.json();
    expect(body.eventId).toBe('msg-9');
    expect(body.message.title).toBe('bob@example.com');
    expect(body.unreadCount).toBe(2);
  });
});
