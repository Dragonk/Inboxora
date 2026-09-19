// Real PostgreSQL tests for the Microsoft Graph calendar read sync (P07d). The provider is faked at the
// HTTP boundary; discovery, the remote link, the stored series, the lease and the delta cursor are real.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=… DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/microsoft/graphCalendarSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import { MICROSOFT_GRANT_AUDIENCE, MICROSOFT_ISSUER, storeOAuthGrant, upsertProviderConnection } from '../../providerAuthService.js';
import { projectCalendarResource } from '../../../utils/calendarRecurrence.js';
import { syncGraphCalendar } from './graphCalendarSync.js';
import type { GraphEvent } from './graphCalendar.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004f1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback', tenantId: 'common', providerRedirectUri: '' };
const originalKey = process.env.ENCRYPTION_KEY;

const DELTA_LINK_1 = 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$deltatoken=1';

const CALENDAR_LIST = {
  value: [
    { id: 'cal-1', name: 'Calendar', canEdit: true, isDefaultCalendar: true, hexColor: '#0f6cbd' },
    { id: 'cal-2', name: 'Team', canEdit: false, hexColor: '#1a7f37' },
  ],
};

const master: GraphEvent = {
  id: 'evt-master', iCalUId: 'standup@contoso.test', subject: 'Standup',
  start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'Europe/Warsaw' },
  end: { dateTime: '2026-09-01T09:30:00.0000000', timeZone: 'Europe/Warsaw' },
  recurrence: { pattern: { type: 'weekly', daysOfWeek: ['tuesday'], interval: 1 }, range: { type: 'numbered', numberOfOccurrences: 4 } },
};
const single: GraphEvent = {
  id: 'evt-single', iCalUId: 'dentist@contoso.test', subject: 'Dentist',
  start: { dateTime: '2026-09-10T15:00:00.0000000', timeZone: 'Europe/Warsaw' },
  end: { dateTime: '2026-09-10T15:30:00.0000000', timeZone: 'Europe/Warsaw' },
};

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/** A fake Graph API: handlers are consumed in call order, URLs are recorded. */
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
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'sub-calendar',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: MICROSOFT_GRANT_AUDIENCE,
      accessToken: 'access-valid',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://graph.microsoft.com/Calendars.ReadWrite'],
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

describeOrSkip('Microsoft Graph calendar sync (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-calendar-user') ON CONFLICT (id) DO NOTHING`,
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

  it('creates hidden read-only calendars, records the provider permission, and stores the series', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json(CALENDAR_LIST),
      () => json({ value: [master, single], '@odata.deltaLink': DELTA_LINK_1 }),
      () => json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-2/events/delta?$deltatoken=2' }),
    ]);

    const result = await syncGraphCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ collections: 2, created: 2, updated: 0, deleted: 0, errors: [] });
    expect(provider.urls[0]).toContain('/me/calendars');
    expect(decodeURIComponent(provider.urls[1])).toContain('/me/calendars/cal-1/events/delta');
    expect(decodeURIComponent(provider.urls[1])).toContain('$select=id,iCalUId');

    const calendars = await autocommit(client => client.query<{ source: string; read_only: boolean; dav_mode: string; color: string }>(
      'SELECT source, read_only, dav_mode, color FROM calendars WHERE user_id = $1 ORDER BY name', [USER_ID],
    ));
    expect(calendars.rows).toHaveLength(2);
    for (const row of calendars.rows) {
      expect(row).toMatchObject({ source: 'microsoft', read_only: true, dav_mode: 'off' });
    }
    expect(calendarColors(calendars.rows)).toEqual(['#0f6cbd', '#1a7f37']);

    // The provider's own permission is recorded on the collection link: the calendar Graph refuses to
    // edit can never be offered for write-back.
    const collections = await autocommit(client => client.query<{ remote_id: string; source_access: string }>(
      'SELECT remote_id, source_access FROM integration_collections WHERE user_id = $1 ORDER BY remote_id', [USER_ID],
    ));
    expect(collections.rows).toEqual([
      { remote_id: 'cal-1', source_access: 'read_write' },
      { remote_id: 'cal-2', source_access: 'read_only' },
    ]);

    const events = await storedEvents();
    expect(events.map(event => event.uid)).toEqual(['dentist@contoso.test', 'standup@contoso.test']);
    const series = events.find(event => event.uid === 'standup@contoso.test');
    if (!series) throw new Error('expected the series to be stored');
    expect(series.raw_ical).toContain('BEGIN:VTIMEZONE');
    expect(series.raw_ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4');
    expect(project(series.raw_ical, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual([
      '2026-09-01T07:00:00.000Z', '2026-09-08T07:00:00.000Z', '2026-09-15T07:00:00.000Z', '2026-09-22T07:00:00.000Z',
    ]);

    const state = await autocommit(client => client.query<{ cursor: string | null }>(
      'SELECT cursor FROM sync_states WHERE user_id = $1 AND feature = $2 ORDER BY created_at ASC', [USER_ID, 'calendars'],
    ));
    expect(state.rows[0]?.cursor).toBe(DELTA_LINK_1);
  });

  it('resumes from the stored delta link and merges a moved instance with a cancelled event', async () => {
    const connectionId = await seedConnection();
    await syncGraphCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([
        () => json(CALENDAR_LIST),
        () => json({ value: [master, single], '@odata.deltaLink': DELTA_LINK_1 }),
        () => json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-2/events/delta?$deltatoken=2' }),
      ]).fetchImpl,
    });

    const moved: GraphEvent = {
      id: 'evt-master_occ', iCalUId: 'standup@contoso.test', seriesMasterId: 'evt-master', type: 'occurrence',
      subject: 'Standup (moved)', originalStart: '2026-09-15T09:00:00.0000000',
      start: { dateTime: '2026-09-16T11:00:00.0000000', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-09-16T12:00:00.0000000', timeZone: 'Europe/Warsaw' },
    };
    const removed: GraphEvent = { id: 'evt-single', '@removed': { reason: 'deleted' } };
    const provider = fakeProvider([
      () => json(CALENDAR_LIST),
      (url) => {
        // The resumed run must start from the link the previous run stored, not from the endpoint.
        expect(url).toBe(DELTA_LINK_1);
        return json({ value: [moved, removed], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$deltatoken=2' });
      },
      () => json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-2/events/delta?$deltatoken=2' }),
    ]);

    const result = await syncGraphCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ collections: 2, created: 0, updated: 1, deleted: 1, errors: [] });

    const events = await storedEvents();
    expect(events.map(event => event.uid)).toEqual(['standup@contoso.test']);
    const series = events[0];
    const occurrences = project(series.raw_ical, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
    expect(occurrences).toContain('2026-09-16T09:00:00.000Z');
    expect(occurrences).not.toContain('2026-09-15T07:00:00.000Z');

    const state = await autocommit(client => client.query<{ cursor: string | null }>(
      `SELECT s.cursor FROM sync_states s JOIN integration_collections ic ON ic.id = s.collection_id
        WHERE s.user_id = $1 AND ic.remote_id = 'cal-1'`, [USER_ID],
    ));
    expect(state.rows[0]?.cursor).toContain('$deltatoken=2');
  });

  it('rebuilds from a baseline when Graph rejects the stored delta link', async () => {
    const connectionId = await seedConnection();
    await syncGraphCalendar({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([
        () => json({ value: [CALENDAR_LIST.value[0]] }),
        () => json({ value: [master, single], '@odata.deltaLink': DELTA_LINK_1 }),
      ]).fetchImpl,
    });
    expect((await storedEvents()).map(event => event.uid)).toEqual(['dentist@contoso.test', 'standup@contoso.test']);

    const provider = fakeProvider([
      () => json({ value: [CALENDAR_LIST.value[0]] }),
      // The stored cursor is gone: Graph answers 410, and the run rebuilds.
      () => json({ error: { code: 'syncStateNotFound', message: 'gone' } }, 410),
      () => json({ value: [master], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$deltatoken=9' }),
    ]);

    const result = await syncGraphCalendar({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ fullSync: true, errors: [] });
    // The rebuild reconciles: the event the baseline no longer lists is gone.
    expect((await storedEvents()).map(event => event.uid)).toEqual(['standup@contoso.test']);
  });
});

function calendarColors(rows: Array<{ color: string }>): string[] {
  return rows.map(row => row.color).sort();
}
