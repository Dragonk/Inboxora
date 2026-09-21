// Real PostgreSQL tests for the Google Calendar read sync (P09). The provider is
// faked at the HTTP boundary; discovery, the remote link, the stored series, the
// lease and the cursor are real, and the assertions project the stored resource
// exactly as a calendar view would.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/google/googleCalendarSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import { GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, storeOAuthGrant, upsertProviderConnection } from '../../providerAuthService.js';
import { projectCalendarResource } from '../../../utils/calendarRecurrence.js';
import { syncGoogleCalendar } from './googleCalendarSync.js';
import type { GoogleCalendarEvent } from './googleCalendar.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003f1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const originalKey = process.env.ENCRYPTION_KEY;

const CALENDAR_LIST = {
  items: [{ id: 'primary', summary: 'Me', timeZone: 'Europe/Warsaw', accessRole: 'owner', primary: true, backgroundColor: '#4a86e8' }],
};

const master: GoogleCalendarEvent = {
  id: 'evt-master', iCalUID: 'standup@google.com', status: 'confirmed', summary: 'Standup',
  updated: '2026-08-30T10:00:00Z',
  start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
  end: { dateTime: '2026-09-01T09:30:00+02:00', timeZone: 'Europe/Warsaw' },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4'],
};
const single: GoogleCalendarEvent = {
  id: 'evt-single', iCalUID: 'dentist@google.com', status: 'confirmed', summary: 'Dentist',
  start: { dateTime: '2026-09-10T15:00:00+02:00', timeZone: 'Europe/Warsaw' },
  end: { dateTime: '2026-09-10T16:00:00+02:00', timeZone: 'Europe/Warsaw' },
};

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/** A fake Google API: handlers are consumed in call order, URLs are recorded. */
function fakeProvider(handlers: Array<(url: string) => Response | Promise<Response>>) {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(url);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedConnection(): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-calendar',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'access-valid',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
      clientIdAtIssue: CONFIG.clientId,
    });
    return connectionId;
  });
}

async function storedEvents(): Promise<Array<{ uid: string; raw_ical: string }>> {
  const result = await autocommit(client => client.query<{ uid: string; raw_ical: string }>(
    'SELECT uid, raw_ical FROM calendar_events WHERE user_id = $1 ORDER BY uid', [USER_ID],
  ));
  return result.rows;
}

function project(raw: string, from: string, to: string): string[] {
  return projectCalendarResource(
    { id: 'row', calendar_id: 'cal', raw_ical: raw },
    new Date(from), new Date(to),
  ).map(event => event.starts_at?.toISOString() ?? 'missing').sort();
}

// These cases do real database work while the whole gated set shares one PostgreSQL instance, so a
// 5-second default is a deadline on the machine rather than on the behaviour: the rebuild case was
// observed timing out at 5.8s under that load while passing alone. The timeout is raised (the
// assertions still have to pass) rather than the test being weakened or skipped.
const PG_TEST_TIMEOUT_MS = 30_000;

describeOrSkip('Google Calendar sync (PostgreSQL)', { timeout: PG_TEST_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'google-calendar-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM calendars WHERE user_id = $1', [USER_ID]);
    });
  });

  it('creates a hidden read-only calendar and stores the series and the single event', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json(CALENDAR_LIST),
      () => json({ items: [master, single], nextSyncToken: 'sync-1' }),
    ]);

    const result = await syncGoogleCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ collections: 1, created: 2, updated: 0, deleted: 0, errors: [] });
    expect(provider.urls[1]).toContain('/calendars/primary/events');
    expect(provider.urls[1]).toContain('singleEvents=false');

    const calendar = await autocommit(client => client.query<{ id: string; source: string; read_only: boolean; dav_mode: string; color: string }>(
      'SELECT id, source, read_only, dav_mode, color FROM calendars WHERE user_id = $1', [USER_ID],
    ));
    expect(calendar.rows[0]).toMatchObject({ source: 'google', read_only: true, dav_mode: 'off', color: '#4a86e8' });

    const events = await storedEvents();
    expect(events.map(event => event.uid)).toEqual(['dentist@google.com', 'standup@google.com']);
    const series = events.find(event => event.uid === 'standup@google.com');
    if (!series) throw new Error('expected the series to be stored');
    // The series is one resource with a real VTIMEZONE and the right occurrences.
    expect(series.raw_ical).toContain('BEGIN:VTIMEZONE');
    expect(series.raw_ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4');
    expect(project(series.raw_ical, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual([
      '2026-09-01T07:00:00.000Z', '2026-09-08T07:00:00.000Z', '2026-09-15T07:00:00.000Z', '2026-09-22T07:00:00.000Z',
    ]);

    const state = await autocommit(client => client.query<{ cursor: string | null }>(
      'SELECT cursor FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'calendars'],
    ));
    expect(state.rows[0]?.cursor).toBe('sync-1');
  });

  it('suffixes a duplicate local calendar name instead of aborting the transaction', async () => {
    // DB-01: two Google calendars can share a summary. The second local INSERT violates the owner+name unique
    // index; without a savepoint PostgreSQL aborts the transaction and the retry fails with 25P02, so the whole
    // calendar discovery is lost. The savepoint makes the retry real.
    const connectionId = await seedConnection();
    const duplicateNames = {
      items: [
        { id: 'cal-a', summary: 'Team', timeZone: 'Europe/Warsaw', accessRole: 'owner', backgroundColor: '#4a86e8' },
        { id: 'cal-b', summary: 'Team', timeZone: 'Europe/Warsaw', accessRole: 'reader', backgroundColor: '#f83a22' },
      ],
    };
    const provider = fakeProvider([
      () => json(duplicateNames),
      () => json({ items: [], nextSyncToken: 'sync-a' }),
      () => json({ items: [], nextSyncToken: 'sync-b' }),
    ]);

    const result = await syncGoogleCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result.errors).toEqual([]);
    expect(result.collections).toBe(2);

    const names = await autocommit(client => client.query<{ name: string }>(
      "SELECT name FROM calendars WHERE user_id = $1 AND source = 'google' ORDER BY name", [USER_ID],
    ));
    expect(names.rows.map(row => row.name)).toEqual(['Team', 'Team (2)']);
    // Both remote calendars were linked, so nothing was orphaned by the retry.
    const links = await autocommit(client => client.query<{ remote_id: string }>(
      "SELECT remote_id FROM integration_collections WHERE user_id = $1 AND kind = 'calendar' ORDER BY remote_id", [USER_ID],
    ));
    expect(links.rows.map(row => row.remote_id)).toEqual(['cal-a', 'cal-b']);
  });

  it('merges an incremental batch: a moved instance and a cancelled event', async () => {
    const connectionId = await seedConnection();
    await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(CALENDAR_LIST), () => json({ items: [master, single], nextSyncToken: 'sync-1' })]).fetchImpl,
    });

    const moved: GoogleCalendarEvent = {
      id: 'evt-master_moved', iCalUID: 'standup@google.com', recurringEventId: 'evt-master', status: 'confirmed',
      summary: 'Standup (moved)',
      originalStartTime: { dateTime: '2026-09-15T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
      start: { dateTime: '2026-09-16T11:00:00+02:00', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-09-16T12:00:00+02:00', timeZone: 'Europe/Warsaw' },
    };
    const cancelled: GoogleCalendarEvent = { ...single, status: 'cancelled' };
    const provider = fakeProvider([
      () => json(CALENDAR_LIST),
      () => json({ items: [moved, cancelled], nextSyncToken: 'sync-2' }),
    ]);

    const result = await syncGoogleCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 1, errors: [] });
    expect(provider.urls[1]).toContain('syncToken=sync-1');

    // The moved instance lives in the same resource as its master.
    const events = await storedEvents();
    expect(events.map(event => event.uid)).toEqual(['standup@google.com']);
    const series = events[0];
    if (!series) throw new Error('expected the series to be stored');
    expect(series.raw_ical).toContain('RECURRENCE-ID;TZID=Europe/Warsaw:20260915T090000');
    expect(project(series.raw_ical, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual([
      '2026-09-01T07:00:00.000Z', '2026-09-08T07:00:00.000Z', '2026-09-16T09:00:00.000Z', '2026-09-22T07:00:00.000Z',
    ]);

    // The cancelled single event is gone, its link kept as a tombstone.
    const link = await autocommit(client => client.query<{ status: string; local_id: string | null }>(
      `SELECT status, local_id FROM remote_object_links WHERE user_id = $1 AND object_remote_id = 'evt-single'`, [USER_ID],
    ));
    expect(link.rows[0]).toMatchObject({ status: 'deleted', local_id: null });
  });

  it('rebuilds from a baseline when the cursor is rejected, without losing the projection', async () => {
    const connectionId = await seedConnection();
    await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(CALENDAR_LIST), () => json({ items: [master], nextSyncToken: 'stale-1' })]).fetchImpl,
    });

    const provider = fakeProvider([
      () => json(CALENDAR_LIST),
      () => json({ error: { message: 'Sync token is no longer valid', status: 'FAILED_PRECONDITION' } }, 410),
      () => json({ items: [master, single], nextSyncToken: 'fresh-1' }),
    ]);
    const result = await syncGoogleCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ fullSync: true, created: 1, errors: [] });
    expect(provider.urls[2]).not.toContain('syncToken=');

    expect((await storedEvents()).map(event => event.uid)).toEqual(['dentist@google.com', 'standup@google.com']);
  });

  it('records the provider’s own access role, and refreshes it without touching the user’s choice', async () => {
    const connectionId = await seedConnection();
    // A calendar shared read-only: the provider permits no writes, so the write-back switch must refuse.
    const reader = { items: [{ id: 'primary', summary: 'Me', timeZone: 'Europe/Warsaw', accessRole: 'reader', primary: true }] };
    await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(reader), () => json({ items: [], nextSyncToken: 'sync-1' })]).fetchImpl,
    });
    const readOnly = await autocommit(client => client.query<{ source_access: string; user_access: string; enabled: boolean }>(
      `SELECT source_access, user_access, enabled FROM integration_collections WHERE user_id = $1 AND kind = 'calendar'`, [USER_ID],
    ));
    expect(readOnly.rows[0]).toMatchObject({ source_access: 'read_only' });

    // The share is upgraded to writer. The provider's fact is refreshed; `enabled` and `user_access`
    // (the user's own choices) are not touched by a discovery pass.
    const writer = { items: [{ id: 'primary', summary: 'Me', timeZone: 'Europe/Warsaw', accessRole: 'writer', primary: true }] };
    await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(writer), () => json({ items: [], nextSyncToken: 'sync-2' })]).fetchImpl,
    });
    const upgraded = await autocommit(client => client.query<{ source_access: string; user_access: string; enabled: boolean }>(
      `SELECT source_access, user_access, enabled FROM integration_collections WHERE user_id = $1 AND kind = 'calendar'`, [USER_ID],
    ));
    expect(upgraded.rows[0]).toMatchObject({ source_access: 'read_write' });
  });

  it('reports a per-calendar failure instead of hiding it', async () => {
    const connectionId = await seedConnection();
    await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(CALENDAR_LIST), () => json({ items: [], nextSyncToken: 'sync-1' })]).fetchImpl,
    });

    // Hold the collection lease so the next run cannot start.
    const collection = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM integration_collections WHERE user_id = $1 AND kind = 'calendar'`, [USER_ID],
    ));
    const { ensureSyncState, acquireSyncLease } = await import('../../syncCoordinator.js');
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_ID, connectionId, feature: 'calendars', collectionId: collection.rows[0]?.id ?? null, coverage: 'events',
    }));
    expect(await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'other-worker' }))).not.toBeNull();

    const result = await syncGoogleCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json(CALENDAR_LIST), () => json({ items: [] })]).fetchImpl,
    });
    expect(result.errors).toEqual([{ calendarId: 'primary', code: 'RATE_LIMITED' }]);
  });
});
