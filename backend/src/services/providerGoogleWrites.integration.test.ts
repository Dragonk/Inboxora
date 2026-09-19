// Real PostgreSQL tests for the Google Calendar/People write path (P09). The provider is faked at the
// HTTP boundary; the durable claim, the journal's terminal status, the target resolution, the
// `remote_object_links` bookkeeping and the capability gate are all real.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_google_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providerGoogleWrites.integration.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, storeOAuthGrant, upsertProviderConnection } from './providerAuthService.js';
import {
  googleEventIdForLocalRow,
  googlePersonLinkForLocalRow,
  recordGoogleCalendarEventLink,
  recordGoogleContactLink,
  removeGoogleCalendarEventLink,
  resolveGoogleCalendarWriteTarget,
  resolveGoogleContactWriteTarget,
  writeGoogleCalendarEvent,
  writeGoogleContact,
} from './providerGoogleWrites.js';
import type { GoogleEventWriteInput } from './providerGoogleWrites.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000007a1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const originalKey = process.env.ENCRYPTION_KEY;
const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  PROVIDER_INTEGRATIONS_ENABLED: process.env.PROVIDER_INTEGRATIONS_ENABLED,
};

interface Call { url: URL; method: string; body: unknown }

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

function noContent(): Response {
  return { ok: true, status: 204, headers: new Headers(), json: async () => null } as Response;
}

/** Route the faked Google API by path; every call is recorded so the request itself can be asserted. */
async function withFetch<T>(
  routes: Array<{ match: RegExp; handle: (url: URL) => Response | Promise<Response> }>,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = String(input);
    const url = new URL(raw);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const route = routes.find(candidate => candidate.match.test(url.pathname));
    if (!route) throw new Error(`Unexpected Google call: ${raw}`);
    return route.handle(url);
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function seedConnection(): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-google-writes',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'access-valid',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/contacts'],
      clientIdAtIssue: CONFIG.clientId,
    });
    await client.query('COMMIT');
    return connectionId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One write-enabled Google calendar collection, exactly as the sync would have to record it. */
async function seedCalendarCollection(connectionId: string, overrides: { user_access?: string; source_access?: string } = {}): Promise<{ calendarId: string; collectionId: string }> {
  return autocommit(async client => {
    const calendar = await client.query<{ id: string }>(
      `INSERT INTO calendars (user_id, owner_user_id, name, source, read_only, dav_mode)
       VALUES ($1, $1, 'Google Calendar', 'google', false, 'off') RETURNING id`,
      [USER_ID],
    );
    const collection = await client.query<{ id: string }>(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1,$2,'calendar','primary',$3,true,$4,$5,'off') RETURNING id`,
      [USER_ID, connectionId, calendar.rows[0].id, overrides.source_access ?? 'read_write', overrides.user_access ?? 'read_write'],
    );
    return { calendarId: calendar.rows[0].id, collectionId: collection.rows[0].id };
  });
}

async function seedContactCollection(connectionId: string, overrides: { user_access?: string } = {}): Promise<{ addressBookId: string; collectionId: string }> {
  return autocommit(async client => {
    const book = await client.query<{ id: string }>(
      `INSERT INTO address_books (user_id, name, source, dav_mode) VALUES ($1, 'Google Contacts', 'google', 'off') RETURNING id`,
      [USER_ID],
    );
    const collection = await client.query<{ id: string }>(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_address_book_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1,$2,'address_book','people/me',$3,true,'read_write',$4,'off') RETURNING id`,
      [USER_ID, connectionId, book.rows[0].id, overrides.user_access ?? 'read_write'],
    );
    return { addressBookId: book.rows[0].id, collectionId: collection.rows[0].id };
  });
}

async function seedEventRow(calendarId: string, uid: string): Promise<string> {
  const result = await autocommit(client => client.query<{ id: string }>(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, summary, starts_at, ends_at, all_day, attendees)
     VALUES ($1,$2,$3,'BEGIN:VCALENDAR\nEND:VCALENDAR','Standup', NOW(), NOW() + interval '30 minutes', false, '[]'::jsonb)
     RETURNING id`,
    [calendarId, USER_ID, uid],
  ));
  return result.rows[0].id;
}

async function seedContactRow(addressBookId: string, uid: string): Promise<string> {
  const result = await autocommit(client => client.query<{ id: string }>(
    `INSERT INTO contacts (address_book_id, user_id, uid, display_name, primary_email, emails)
     VALUES ($1,$2,$3,'Ada','ada@example.test','[{"value":"ada@example.test","primary":true}]'::jsonb) RETURNING id`,
    [addressBookId, USER_ID, uid],
  ));
  return result.rows[0].id;
}

/** The journal row for the newest operation, as a later reader would find it. */
async function latestOperation(): Promise<{ status: string; error_code: string | null; resource_id: string | null; resource_type: string } | null> {
  const result = await autocommit(client => client.query<{ status: string; error_code: string | null; resource_id: string | null; resource_type: string }>(
    'SELECT status, error_code, resource_id, resource_type FROM provider_operations WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [USER_ID],
  ));
  return result.rows[0] ?? null;
}

const eventInput: GoogleEventWriteInput = {
  summary: 'Standup', description: 'Daily', location: 'Room 1', url: null,
  startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T09:30:00.000Z'),
  allDay: false, attendees: ['a@example.test'],
  recurrence: { frequency: 'weekly', interval: 1, byWeekday: [2], until: null, untilIcal: null, count: 4 },
};

describeOrSkip('Google provider writes (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.GOOGLE_CLIENT_ID = CONFIG.clientId;
    process.env.GOOGLE_CLIENT_SECRET = CONFIG.clientSecret;
    process.env.GOOGLE_REDIRECT_URI = CONFIG.redirectUri;
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'google-writes-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM calendars WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM address_books WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM integration_config WHERE provider = $1', ['google']);
    });
  });

  afterEach(() => {
    delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
  });

  it('creates an event at Google, journals it, and links the provider identity', async () => {
    const connectionId = await seedConnection();
    const { calendarId, collectionId } = await seedCalendarCollection(connectionId);

    const target = await resolveGoogleCalendarWriteTarget(USER_ID, calendarId);
    expect(target).toMatchObject({ kind: 'google', providerCalendarId: 'primary' });
    if (target.kind !== 'google') throw new Error('expected a Google target');

    const created = await withFetch(
      [{ match: /\/calendars\/primary\/events$/, handle: () => json({ id: 'evt-1', iCalUID: 'evt-1@google.com' }) }],
      async calls => {
        const outcome = await writeGoogleCalendarEvent({
          userId: USER_ID, target, operation: 'create', event: eventInput, sendUpdates: 'all', idempotencyKey: 'intent-1',
        });
        expect(outcome).toMatchObject({ status: 'confirmed', providerEventId: 'evt-1' });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url.searchParams.get('sendUpdates')).toBe('all');
        expect(calls[0].body).toMatchObject({
          summary: 'Standup',
          start: { dateTime: '2026-09-01T09:00:00.000Z', timeZone: 'UTC' },
          attendees: [{ email: 'a@example.test' }],
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4'],
        });
        return outcome;
      },
    );

    const operation = await latestOperation();
    expect(operation).toMatchObject({ status: 'committed', resource_type: 'calendar_event', resource_id: null });

    const localId = await seedEventRow(calendarId, created.status === 'confirmed' ? `${created.providerEventId}@google.com` : 'missing');
    await recordGoogleCalendarEventLink({ userId: USER_ID, target, providerEventId: 'evt-1', localId });
    await expect(googleEventIdForLocalRow(USER_ID, collectionId, localId)).resolves.toBe('evt-1');

    // A second create with the same intent replays the journal instead of creating a second event.
    const calls = await withFetch(
      [{ match: /\/calendars\/primary\/events$/, handle: () => json({ id: 'evt-2' }) }],
      async recorded => {
        const replay = await writeGoogleCalendarEvent({
          userId: USER_ID, target, operation: 'create', event: eventInput, sendUpdates: 'all', idempotencyKey: 'intent-1',
        });
        expect(recorded).toHaveLength(0);
        return replay;
      },
    );
    expect(calls).toMatchObject({ status: 'confirmed', providerEventId: 'evt-1' });
  });

  it('updates an event with the provider id and journals the local row id', async () => {
    const connectionId = await seedConnection();
    const { calendarId, collectionId } = await seedCalendarCollection(connectionId);
    const target = await resolveGoogleCalendarWriteTarget(USER_ID, calendarId);
    if (target.kind !== 'google') throw new Error('expected a Google target');

    const localId = await seedEventRow(calendarId, 'evt-1@google.com');
    await recordGoogleCalendarEventLink({ userId: USER_ID, target, providerEventId: 'evt-1', localId });
    await expect(googleEventIdForLocalRow(USER_ID, collectionId, localId)).resolves.toBe('evt-1');

    await withFetch(
      [{ match: /\/calendars\/primary\/events\/evt-1$/, handle: () => json({ id: 'evt-1' }) }],
      async calls => {
        const outcome = await writeGoogleCalendarEvent({
          userId: USER_ID, target, operation: 'update', providerEventId: 'evt-1',
          event: { ...eventInput, summary: 'Standup (moved)' }, sendUpdates: 'none', localResourceId: localId,
        });
        expect(outcome).toMatchObject({ status: 'confirmed' });
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].url.searchParams.get('sendUpdates')).toBe('none');
        expect(calls[0].body).toMatchObject({ summary: 'Standup (moved)' });
      },
    );

    // The journal column is a UUID: it holds the local row, never the provider id.
    expect(await latestOperation()).toMatchObject({ status: 'committed', resource_id: localId });
  });

  it('deletes an event, tombstones the link, and treats a vanished event as deleted', async () => {
    const connectionId = await seedConnection();
    const { calendarId, collectionId } = await seedCalendarCollection(connectionId);
    const target = await resolveGoogleCalendarWriteTarget(USER_ID, calendarId);
    if (target.kind !== 'google') throw new Error('expected a Google target');
    const localId = await seedEventRow(calendarId, 'evt-1@google.com');
    await recordGoogleCalendarEventLink({ userId: USER_ID, target, providerEventId: 'evt-1', localId });

    await withFetch(
      [{ match: /\/calendars\/primary\/events\/evt-1$/, handle: () => noContent() }],
      async calls => {
        await expect(writeGoogleCalendarEvent({
          userId: USER_ID, target, operation: 'delete', providerEventId: 'evt-1', sendUpdates: 'all', localResourceId: localId,
        })).resolves.toMatchObject({ status: 'confirmed' });
        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].url.searchParams.get('sendUpdates')).toBe('all');
      },
    );
    await removeGoogleCalendarEventLink({ userId: USER_ID, target, providerEventId: 'evt-1' });
    await expect(googleEventIdForLocalRow(USER_ID, collectionId, localId)).resolves.toBeNull();

    // Google answering 404 for an event that is already gone is the end state, not a retryable failure.
    await withFetch(
      [{ match: /\/calendars\/primary\/events\/evt-1$/, handle: () => json({ error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } }, 404) }],
      async () => {
        await expect(writeGoogleCalendarEvent({
          userId: USER_ID, target, operation: 'delete', providerEventId: 'evt-1', sendUpdates: 'all', localResourceId: localId,
        })).resolves.toMatchObject({ status: 'failed', failure: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
      },
    );
  });

  it('records a refusal as a permanent failed operation and a throttle as a scheduled retry', async () => {
    const connectionId = await seedConnection();
    const { calendarId } = await seedCalendarCollection(connectionId);
    const target = await resolveGoogleCalendarWriteTarget(USER_ID, calendarId);
    if (target.kind !== 'google') throw new Error('expected a Google target');

    await withFetch(
      [{ match: /\/calendars\/primary\/events$/, handle: () => json({ error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } }, 403) }],
      async () => {
        const outcome = await writeGoogleCalendarEvent({ userId: USER_ID, target, operation: 'create', event: eventInput, sendUpdates: 'none' });
        expect(outcome).toMatchObject({ status: 'failed', failure: { status: 403, code: 'INSUFFICIENT_SCOPES' } });
      },
    );
    expect(await latestOperation()).toMatchObject({ status: 'failed', error_code: 'INSUFFICIENT_SCOPES' });

    await withFetch(
      [{ match: /\/calendars\/primary\/events$/, handle: () => json({ error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 429) }],
      async () => {
        const outcome = await writeGoogleCalendarEvent({ userId: USER_ID, target, operation: 'create', event: eventInput, sendUpdates: 'none' });
        expect(outcome).toMatchObject({ status: 'failed', failure: { status: 503, code: 'RATE_LIMITED' } });
      },
    );
    // A retryable answer asserts nothing was applied, so it is scheduled rather than parked.
    expect(await latestOperation()).toMatchObject({ status: 'pending', error_code: 'RATE_LIMITED' });
  });

  it('creates a contact at People with the resource mask, then updates it with its own etag and update mask', async () => {
    const connectionId = await seedConnection();
    const { addressBookId, collectionId } = await seedContactCollection(connectionId);
    const target = await resolveGoogleContactWriteTarget(USER_ID, addressBookId);
    expect(target).toMatchObject({ kind: 'google', collectionRemoteId: 'people/me' });
    if (target.kind !== 'google') throw new Error('expected a Google target');

    const created = await withFetch(
      [{ match: /\/people:createContact$/, handle: () => json({ resourceName: 'people/c1', etag: 'etag-1', names: [{ givenName: 'Ada' }] }) }],
      async calls => {
        const outcome = await writeGoogleContact({
          userId: USER_ID, target, operation: 'create',
          contact: { displayName: 'Ada', emails: [{ value: 'ada@example.test', primary: true }] },
        });
        expect(outcome).toMatchObject({ status: 'confirmed', providerContactId: 'people/c1' });
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url.searchParams.get('personFields')).toContain('emailAddresses');
        expect(calls[0].body).toMatchObject({
          names: [{ unstructuredName: 'Ada' }],
          emailAddresses: [{ value: 'ada@example.test', metadata: { primary: true } }],
        });
        return outcome;
      },
    );
    expect(await latestOperation()).toMatchObject({ status: 'committed', resource_type: 'contact', resource_id: null });

    const localId = await seedContactRow(addressBookId, 'google-c1');
    const etag = created.status === 'confirmed' ? created.person?.etag ?? null : null;
    await recordGoogleContactLink({ userId: USER_ID, target, providerContactId: 'people/c1', localId, etag });
    await expect(googlePersonLinkForLocalRow(USER_ID, collectionId, localId)).resolves.toEqual({ resourceName: 'people/c1', etag: 'etag-1' });

    await withFetch(
      [{ match: /\/people\/c1:updateContact$/, handle: () => json({ resourceName: 'people/c1', etag: 'etag-2' }) }],
      async calls => {
        const outcome = await writeGoogleContact({
          userId: USER_ID, target, operation: 'update', providerContactId: 'people/c1',
          contact: { displayName: 'Ada Lovelace', emails: [{ value: 'ada@example.test', primary: true }] },
          etag: 'etag-1', localResourceId: localId,
        });
        expect(outcome).toMatchObject({ status: 'confirmed', providerContactId: 'people/c1' });
        expect(calls[0].method).toBe('PATCH');
        // The mask names exactly the fields the body sends, and the etag the link stored is presented.
        expect(calls[0].url.searchParams.get('updatePersonFields')).toBe('names,emailAddresses');
        expect(calls[0].body).toMatchObject({ etag: 'etag-1', names: [{ unstructuredName: 'Ada Lovelace' }] });
      },
    );
    expect(await latestOperation()).toMatchObject({ status: 'committed', resource_id: localId });
  });

  it('deletes a contact at People and treats a vanished person as removed', async () => {
    const connectionId = await seedConnection();
    const { addressBookId, collectionId } = await seedContactCollection(connectionId);
    const target = await resolveGoogleContactWriteTarget(USER_ID, addressBookId);
    if (target.kind !== 'google') throw new Error('expected a Google target');
    const localId = await seedContactRow(addressBookId, 'google-c1');
    await recordGoogleContactLink({ userId: USER_ID, target, providerContactId: 'people/c1', localId, etag: 'etag-1' });

    await withFetch(
      [{ match: /\/people\/c1:deleteContact$/, handle: () => json({}) }],
      async calls => {
        await expect(writeGoogleContact({ userId: USER_ID, target, operation: 'delete', providerContactId: 'people/c1', localResourceId: localId }))
          .resolves.toMatchObject({ status: 'confirmed', providerContactId: 'people/c1' });
        expect(calls[0].method).toBe('DELETE');
      },
    );
    await expect(googlePersonLinkForLocalRow(USER_ID, collectionId, localId)).resolves.toMatchObject({ resourceName: 'people/c1' });

    await withFetch(
      [{ match: /\/people\/c1:deleteContact$/, handle: () => json({ error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } }, 404) }],
      async () => {
        await expect(writeGoogleContact({ userId: USER_ID, target, operation: 'delete', providerContactId: 'people/c1', localResourceId: localId }))
          .resolves.toMatchObject({ status: 'failed', failure: { status: 404, code: 'RESOURCE_NOT_FOUND' } });
      },
    );
  });

  it('makes no outbound call when the layer or the method switch is off, or the collection is read-only', async () => {
    const connectionId = await seedConnection();
    const { calendarId } = await seedCalendarCollection(connectionId);
    const { addressBookId } = await seedContactCollection(connectionId);

    await withFetch([], async calls => {
      process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
      await expect(resolveGoogleCalendarWriteTarget(USER_ID, calendarId)).resolves.toMatchObject({ kind: 'refused', status: 403 });
      delete process.env.PROVIDER_INTEGRATIONS_ENABLED;

      await autocommit(client => client.query(
        `INSERT INTO integration_config (provider, config) VALUES ('google', '{"apiEnabled": false}'::jsonb)
         ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config`,
      ));
      await expect(resolveGoogleCalendarWriteTarget(USER_ID, calendarId)).resolves.toMatchObject({ kind: 'refused', status: 403 });

      await autocommit(client => client.query("DELETE FROM integration_config WHERE provider = 'google'"));
      expect(calls).toHaveLength(0);
    });

    // A collection the user has not opted in stays refused by the shared capability model, whichever
    // provider it belongs to — the Google adapter does not widen that gate.
    await autocommit(client => client.query(
      "UPDATE integration_collections SET user_access = 'source' WHERE user_id = $1",
      [USER_ID],
    ));
    await withFetch([], async calls => {
      await expect(resolveGoogleCalendarWriteTarget(USER_ID, calendarId)).resolves.toEqual({ kind: 'not_google' });
      await expect(resolveGoogleContactWriteTarget(USER_ID, addressBookId)).resolves.toEqual({ kind: 'not_google' });
      expect(calls).toHaveLength(0);
    });
  });
});
