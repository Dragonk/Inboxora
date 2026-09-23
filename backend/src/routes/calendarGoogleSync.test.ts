import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), syncGoogleCalendar: vi.fn(), configured: { value: true }, featureEnabled: { value: true }, operational: { value: true } }));

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
// Keep every real export and override only what this suite needs: the router pulls
// the token service in transitively, so a narrower mock breaks module evaluation.
vi.mock('../services/providerSwitches.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerSwitches.js')>()),
  providerOperationalForSync: vi.fn(async () => mocks.operational.value),
}));
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  googleConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' }),
  isGoogleConfigured: () => mocks.configured.value,
}));
vi.mock('../services/providers/google/googleCalendarSync.js', () => ({
  syncGoogleCalendar: mocks.syncGoogleCalendar,
}));
vi.mock('../services/accountProviderFeatureSettings.js', () => ({
  providerConnectionFeatureEnabled: vi.fn(async () => mocks.featureEnabled.value),
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
// The preflight and the failure describer read the grant and the account; this suite is about the route's
// per-connection fan-out, so they answer directly rather than through the database mock.
vi.mock('../services/providerSyncDiagnostics.js', () => ({
  providerSyncPreflight: vi.fn(async () => null),
  describeProviderSyncFailure: vi.fn(async (input: { connectionId: string; feature: string; caught: unknown }) => {
    const failure = input.caught as { code?: string; message?: string } | null;
    return {
      connectionId: input.connectionId,
      accountId: null,
      feature: input.feature,
      code: failure?.code ?? 'PROVIDER_ERROR',
      providerStatus: null,
      message: failure?.message ?? 'failed',
      retryable: false,
    };
  }),
}));

import { GoogleApiError } from '../services/providers/google/googleApiClient.js';

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
  mocks.featureEnabled.value = true;
  mocks.operational.value = true;
  mocks.query.mockReset();
  mocks.syncGoogleCalendar.mockReset();
});

const status = () => fetch(`${base}/api/calendar/providers/google/status`);
const sync = () => fetch(`${base}/api/calendar/providers/google/sync`, { method: 'POST' });

describe('GET /api/calendar/providers/google/status', () => {
  it('reports readiness, connections and per-calendar progress without secrets', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] })
      .mockResolvedValueOnce({ rows: [{
        connection_id: 'connection-1', calendar_id: 'calendar-1', name: 'Me',
        event_count: 42, last_success_at: '2026-09-14T10:00:00.000Z', last_error_code: null, last_error_at: null,
      }] });

    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      connected: true,
      connections: 1,
      calendars: [{
        connectionId: 'connection-1', calendarId: 'calendar-1', name: 'Me',
        eventCount: 42, lastSyncedAt: '2026-09-14T10:00:00.000Z', lastErrorCode: null, lastErrorAt: null,
      }],
    });
    const [connectionSql, connectionParams] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(connectionSql).toContain("provider = 'google'");
    expect(connectionParams).toEqual(['user-1']);
    const [calendarSql, calendarParams] = mocks.query.mock.calls[1] as [string, unknown[]];
    expect(calendarSql).toContain('ic.user_id = $1');
    expect(calendarParams).toEqual(['user-1']);
  });

  it('reports not connected when the user has no Google connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await (await status()).json()).toEqual({ configured: true, connected: false, connections: 0, calendars: [] });
  });
});

describe('POST /api/calendar/providers/google/sync', () => {
  it('refuses before any query or provider call when the Google API is disabled', async () => {
    mocks.operational.value = false;
    const response = await sync();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Google API is disabled by the administrator' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
  });

  it('asks the user to connect an account when there is no Google connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Connect a Google account before syncing calendars' });
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
  });

  it('reports missing administrator configuration instead of attempting the sync', async () => {
    mocks.configured.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    const response = await sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Google API is not configured by the administrator' });
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
  });

  it('does not call Google when calendars are disabled for the account connection', async () => {
    mocks.featureEnabled.value = false;
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }] });
    const response = await sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ connectionId: 'connection-1', error: { code: 'FEATURE_DISABLED' } }] });
    expect(mocks.syncGoogleCalendar).not.toHaveBeenCalled();
  });

  it('returns a per-connection result and does not hide one failure behind another', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'connection-1' }, { id: 'connection-2' }] });
    mocks.syncGoogleCalendar
      .mockResolvedValueOnce({ collections: 2, created: 5, updated: 1, deleted: 0, skipped: 0, fullSync: true, errors: [] })
      .mockRejectedValueOnce(new GoogleApiError({ code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid Credentials', status: 401 }));

    const response = await sync();
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({ connectionId: 'connection-1', collections: 2, created: 5, fullSync: true });
    // The failure carries the feature it belongs to and the connection it came from, which is what the
    // interface needs to say which service failed and what to do about it.
    expect(body.results[1]).toMatchObject({
      connectionId: 'connection-2',
      error: {
        connectionId: 'connection-2', feature: 'calendar',
        code: 'PROVIDER_AUTH_REQUIRED', message: 'Invalid Credentials', retryable: false,
      },
    });
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("provider = 'google'");
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual(['user-1']);
  });
});
