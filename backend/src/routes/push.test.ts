import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';
import type {
  listPushDevices as ListPushDevices,
  registerPushDevice as RegisterPushDevice,
  removePushDevice as RemovePushDevice,
  removeAllPushDevices as RemoveAllPushDevices,
  pruneStalePushDevices as PruneStalePushDevices,
} from '../services/pushDevices.js';
import type { transportStatus as TransportStatus } from '../services/pushTransports.js';
import type { query as Query } from '../services/db.js';
import type { upcomingCalendarReminders as UpcomingCalendarReminders } from '../services/calendarReminders.js';

// The mocked middleware only reads these fields off the augmented Request.
type PushDeviceAttrs = Pick<NonNullable<Request['pushDevice']>, 'id' | 'userId' | 'deviceId'>;

const {
  listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices,
  transportStatus, query, upcomingCalendarReminders,
} = vi.hoisted(() => ({
  listPushDevices: vi.fn<typeof ListPushDevices>(),
  registerPushDevice: vi.fn<typeof RegisterPushDevice>(),
  removePushDevice: vi.fn<typeof RemovePushDevice>(),
  removeAllPushDevices: vi.fn<typeof RemoveAllPushDevices>(),
  pruneStalePushDevices: vi.fn<typeof PruneStalePushDevices>(),
  transportStatus: vi.fn<typeof TransportStatus>(),
  query: vi.fn<typeof Query>(),
  upcomingCalendarReminders: vi.fn<typeof UpcomingCalendarReminders>(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../middleware/deviceAuth.js', () => ({
  requireDeviceAuth: (req: { pushDevice?: PushDeviceAttrs }, _res: Response, next: NextFunction) => { req.pushDevice = { id: 'row-1', userId: 'user-1', deviceId: 'device-1' }; next(); },
}));
vi.mock('../services/pushDevices.js', () => ({
  listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices,
}));
vi.mock('../services/pushTransports.js', () => ({ transportStatus }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: true }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/calendarReminders.js', () => ({ upcomingCalendarReminders }));

import express from 'express';
import pushRouter from './push.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  for (const fn of [listPushDevices, registerPushDevice, removePushDevice, removeAllPushDevices, pruneStalePushDevices, transportStatus, query, upcomingCalendarReminders]) fn.mockReset();
  pruneStalePushDevices.mockResolvedValue(0);
  transportStatus.mockReturnValue({ live: true, fcm: false });
});

describe('POST /api/push/devices', () => {
  it('registers for the session user and returns the device token exactly once', async () => {
    registerPushDevice.mockResolvedValue({
      device: { id: 'row-1', device_id: 'device-1', platform: 'android', transport: 'live', app_version: '4.0.0', created_at: new Date('2024-01-01T00:00:00.000Z'), updated_at: new Date('2024-01-01T00:00:00.000Z'), last_seen: new Date('2024-01-01T00:00:00.000Z') },
      deviceToken: 'mf_push_11111111-2222-3333-4444-555555555555.secret',
    });

    const response = await fetch(`${base}/api/push/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1', platform: 'android', transport: 'live', appVersion: '4.0.0' }),
    });
    const body = (await response.json()) as JsonBody;
    assert.ok(body.device);

    expect(response.status).toBe(201);
    expect(body.deviceToken).toBe('mf_push_11111111-2222-3333-4444-555555555555.secret');
    // The user id comes from the session, never the request body.
    expect(registerPushDevice).toHaveBeenCalledWith('user-1', expect.objectContaining({ deviceId: 'device-1' }));
    expect(body.device.endpoint).toBeUndefined();
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
    listPushDevices.mockResolvedValue([{ id: 'row-1', device_id: 'device-1', platform: 'android', transport: 'fcm', app_version: '4.0.0', created_at: new Date('2024-01-01T00:00:00.000Z'), updated_at: new Date('2024-01-02T00:00:00.000Z'), last_seen: new Date('2024-01-03T00:00:00.000Z'), disabled_at: null }]);
    const response = await fetch(`${base}/api/push/devices`);
    const body = (await response.json()) as JsonBody;
    assert.ok(body.devices);
    expect(listPushDevices).toHaveBeenCalledWith('user-1');
    expect(body.devices[0]).toEqual({ id: 'row-1', deviceId: 'device-1', platform: 'android', transport: 'fcm', appVersion: '4.0.0', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z', lastSeen: '2024-01-03T00:00:00.000Z', disabled: false });
    expect(JSON.stringify(body)).not.toMatch(/endpoint|token/i);
  });

  it('unregisters a device scoped to the caller and 404s another user device', async () => {
    removePushDevice.mockResolvedValueOnce({ id: 'row-1', device_id: 'device-1', transport: 'fcm' });
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
    expect((await response.json()) as JsonBody).toEqual({ ok: true, removed: 2 });
    expect(removeAllPushDevices).toHaveBeenCalledWith('user-1');
  });

  it('reports transport availability without leaking device secrets', async () => {
    query.mockResolvedValue({ rows: [{ total: 2, active: 1 }] });
    const response = await fetch(`${base}/api/push/status`);
    const body = (await response.json()) as JsonBody;
    expect(body).toEqual({
      webPushConfigured: true,
      nativeTransports: { live: true, fcm: false },
      devices: { total: 2, active: 1 },
    });
  });
});

describe('native background API', () => {
  const EVENT_ID = '11111111-1111-1111-1111-111111111111';

  it('returns notification details for an owned message', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)::int AS total')) return Promise.resolve({ rows: [{ total: 5 }] });
      return Promise.resolve({ rows: [{ id: EVENT_ID, subject: 'Hello', from_name: 'Ada', from_email: 'ada@example.com', account_id: 'acct-1', folder: 'INBOX' }] });
    });
    const response = await fetch(`${base}/api/push/native/messages/${EVENT_ID}`);
    const body = (await response.json()) as JsonBody;
    expect(response.status).toBe(200);
    expect(body).toEqual({
      eventId: EVENT_ID,
      message: { messageId: EVENT_ID, accountId: 'acct-1', folder: 'INBOX', title: 'Ada', body: 'Hello', snippet: null },
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
    query.mockImplementation((sql: string) => {
      if (sql.includes('ORDER BY m.date')) return Promise.resolve({ rows: [{ id: 'msg-9', subject: 'Latest', from_name: '', from_email: 'bob@example.com', account_id: 'acct-1', folder: 'INBOX', snippet: 'Latest preview text' }] });
      return Promise.resolve({ rows: [{ total: 2 }] });
    });
    const response = await fetch(`${base}/api/push/native/inbox`);
    const body = (await response.json()) as JsonBody;
    assert.ok(body.message);
    expect(body.eventId).toBe('msg-9');
    expect(body.message.title).toBe('bob@example.com');
    expect(body.message.snippet).toBe('Latest preview text');
    expect(body.unreadCount).toBe(2);
  });

  it('leaves fallback wording to the device and trims the preview to 200 characters', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)::int AS total')) return Promise.resolve({ rows: [{ total: 1 }] });
      return Promise.resolve({ rows: [{ id: EVENT_ID, subject: null, from_name: null, from_email: null, account_id: 'acct-1', folder: 'INBOX', snippet: 'x'.repeat(250) }] });
    });
    const response = await fetch(`${base}/api/push/native/messages/${EVENT_ID}`);
    const body = (await response.json()) as JsonBody;
    assert.ok(body.message);
    // No hardcoded English placeholders: the device picks the localized fallback.
    expect(body.message.title).toBeNull();
    expect(body.message.body).toBeNull();
    expect((body.message.snippet as string)).toHaveLength(200);
  });

  it('answers the read-check with only the still-unread subset', async () => {
    query.mockResolvedValue({ rows: [{ id: '11111111-2222-3333-4444-555555555555' }] });
    const response = await fetch(`${base}/api/push/native/read-check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageIds: [
        '11111111-2222-3333-4444-555555555555',
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'not-a-uuid',
      ] }),
    });
    const body = (await response.json()) as JsonBody;
    // The malformed id is filtered before the query; the read one is absent from
    // the answer so the client cancels its notification.
    expect(body.unread).toEqual(['11111111-2222-3333-4444-555555555555']);
    expect(query.mock.calls[0][1]).toEqual(['user-1', ['11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']]);
  });

  it('short-circuits a read-check without ids', async () => {
    const response = await fetch(`${base}/api/push/native/read-check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageIds: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unread: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('exposes the reminder schedule for the device, bounded to 72 hours', async () => {
    upcomingCalendarReminders.mockResolvedValue([{ key: 'e1', eventId: 'e1', calendarId: 'cal-1', calendarName: 'Work', summary: 'Standup', location: null, startsAt: '2026-10-19T10:00:00Z', endsAt: '2026-10-19T10:30:00Z', allDay: false, minutes: 30, remindAt: '2026-10-19T09:30:00Z', mode: 'notification' }]);
    const response = await fetch(`${base}/api/push/native/reminders?windowHours=999`);
    const body = (await response.json()) as JsonBody;
    expect(body.windowHours).toBe(72);
    expect(body.reminders).toHaveLength(1);
    const [userId, window] = upcomingCalendarReminders.mock.calls[0];
    expect(userId).toBe('user-1');
    assert.ok(window.to instanceof Date);
    expect(window.to.getTime() - window.from.getTime()).toBe(72 * 3_600_000);
    // The grace for a device clock drift is added before the window starts.
    assert.ok(Date.now() - window.from.getTime() >= 120_000);
  });
});
