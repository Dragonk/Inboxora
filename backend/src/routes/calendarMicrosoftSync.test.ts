import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), syncGraphCalendar: vi.fn(), configured: { value: true } }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
// Keep every real export and override only what this suite needs: the router pulls the token service in
// transitively, so a narrower mock breaks module evaluation.
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'ms-client', clientSecret: 'ms-secret', redirectUri: 'https://inboxora.example/oauth/provider/microsoft/callback', tenantId: 'common' }),
  isMicrosoftConfigured: () => mocks.configured.value,
}));
vi.mock('../services/providers/microsoft/graphCalendarSync.js', () => ({
  syncGraphCalendar: mocks.syncGraphCalendar,
}));
vi.mock('../services/calendarInvitation.js', () => ({
  sendCalendarInvitation: vi.fn(),
  prepareCalendarInvitation: vi.fn(),
}));
vi.mock('../services/externalCalendarSync.js', () => ({
  releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn(),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
vi.mock('../services/inboundCalendarInvitation.js', () => ({ parseInboundCalendarInvitation: vi.fn() }));

import calendarRouter from './calendar.js';
import { GraphApiError } from '../services/providers/microsoft/graphApiClient.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.configured.value = true;
  mocks.query.mockReset();
  mocks.syncGraphCalendar.mockReset();
});

const status = () => fetch(`${base}/api/calendar/providers/microsoft/status`);
const sync = () => fetch(`${base}/api/calendar/providers/microsoft/sync`, { method: 'POST' });

describe('GET /api/calendar/providers/microsoft/status', () => {
  it('reports readiness and per-calendar progress, scoped to Microsoft collections', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] })
      .mockResolvedValueOnce({ rows: [{
        connection_id: 'connection-1', calendar_id: 'calendar-1', name: 'Calendar', source_access: 'read_write',
        event_count: 7, last_success_at: '2026-09-14T10:00:00.000Z', last_error_code: null, last_error_at: null,
      }] });

    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      connected: true,
      connections: 1,
      calendars: [{
        connectionId: 'connection-1', calendarId: 'calendar-1', name: 'Calendar', canWriteAtSource: true,
        eventCount: 7, lastSyncedAt: '2026-09-14T10:00:00.000Z', lastErrorCode: null, lastErrorAt: null,
      }],
    });
    const [connectionSql, connectionParams] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(connectionSql).toContain("provider = 'microsoft'");
    expect(connectionParams).toEqual(['user-1']);
    // A Microsoft calendar and a Google calendar share the `calendar` collection kind, so the provider
    // is part of the filter rather than a `kind` alone.
    const [calendarSql] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(calendarSql).toContain("pc.provider = 'microsoft'");
    expect(calendarSql).toContain('ic.kind = ');
  });

  it('reports a calendar the provider refuses to write as not writable at source', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] })
      .mockResolvedValueOnce({ rows: [{
        connection_id: 'connection-1', calendar_id: 'calendar-2', name: 'Team', source_access: 'read_only',
        event_count: 0, last_success_at: null, last_error_code: null, last_error_at: null,
      }] });
    const body = await (await status()).json() as { calendars: Array<{ canWriteAtSource: boolean }> };
    expect(body.calendars[0]?.canWriteAtSource).toBe(false);
  });
});

describe('POST /api/calendar/providers/microsoft/sync', () => {
  it('asks the user to connect an account when there is no Microsoft connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Connect a Microsoft account before syncing calendars' });
    expect(mocks.syncGraphCalendar).not.toHaveBeenCalled();
  });

  it('reports missing administrator configuration instead of attempting the sync', async () => {
    mocks.configured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Microsoft API is not configured by the administrator' });
    expect(mocks.syncGraphCalendar).not.toHaveBeenCalled();
  });

  it('does not hide one connection’s failure behind another', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }, { id: 'connection-2' }] });
    mocks.syncGraphCalendar
      .mockResolvedValueOnce({ collections: 2, created: 5, updated: 1, deleted: 0, skipped: 0, fullSync: true, errors: [] })
      .mockRejectedValueOnce(new GraphApiError({ code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid authentication token', status: 401 }));

    const response = await sync();
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ connectionId: 'connection-1', collections: 2, created: 5, fullSync: true });
    expect(body.results[1]).toEqual({
      connectionId: 'connection-2',
      error: { code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid authentication token', retryable: false },
    });
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("provider = 'microsoft'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual(['user-1']);
  });
});
