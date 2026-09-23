// Real-PostgreSQL coverage for the provider write journal itself (the Microsoft contact and
// calendar-event paths, P09). Every unit test of those paths mocks `runProviderMutation`, which is
// exactly how a real column type can hide: `provider_operations.resource_id` is a UUID, and binding a
// provider id (`AAMkAD-…`) there fails the INSERT before any network call. These cases therefore drive
// the real journal against a real database and assert what it stored.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=… DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerWritesJournal.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool, query } from './db.js';
import { MICROSOFT_ISSUER, upsertProviderConnection } from './providerAuthService.js';
import { writeGraphCalendarEvent } from './providerCalendarWrites.js';
import { writeGraphContact } from './providerContactWrites.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000005f1';
const originalKey = process.env.ENCRYPTION_KEY;
const LOCAL_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const LOCAL_CONTACT_ID = '66666666-7777-4888-8999-000000000000';

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

interface Seeded {
  connectionId: string;
  collectionId: string;
}

async function seed(): Promise<Seeded> {
  return autocommit(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'sub-journal',
    });
    const collection = await client.query<{ id: string }>(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1,$2,'calendar','cal-1',true,'read_write','read_write','off')
       RETURNING id`,
      [USER_ID, connectionId],
    );
    return { connectionId, collectionId: collection.rows[0]!.id };
  });
}

async function lastOperation(): Promise<{ resource_type: string; operation: string; resource_id: string | null; status: string } | null> {
  const result = await query<{ resource_type: string; operation: string; resource_id: string | null; status: string }>(
    `SELECT resource_type, operation, resource_id, status FROM provider_operations
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [USER_ID],
  );
  return result.rows[0] ?? null;
}

const event = {
  summary: 'Standup', description: null, location: null, url: null,
  startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T09:30:00.000Z'),
  allDay: false, attendees: [], recurrence: null,
};

describeOrSkip('the provider write journal (PostgreSQL)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'journal-user') ON CONFLICT (id) DO NOTHING`,
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
      await client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]);
    });
    seeded = await seed();
  });

  it('journals the local calendar-event id, never the provider’s', async () => {
    const outcome = await writeGraphCalendarEvent({
      userId: USER_ID,
      target: {
        kind: 'graph', connectionId: seeded.connectionId, collectionId: seeded.collectionId,
        providerCalendarId: 'cal-1', calendarId: LOCAL_EVENT_ID,
      },
      operation: 'update',
      providerEventId: 'AAMkAD-evt-1',
      localResourceId: LOCAL_EVENT_ID,
      event,
      providerCalls: { patch: async () => ({ id: 'AAMkAD-evt-1' }) },
    });

    expect(outcome).toMatchObject({ status: 'confirmed', providerEventId: 'AAMkAD-evt-1' });
    // The row the journal wrote is the local identity, and the provider's id is not in that column.
    expect(await lastOperation()).toMatchObject({
      resource_type: 'calendar_event', operation: 'update', resource_id: LOCAL_EVENT_ID, status: 'committed',
    });
  });

  it('journals the local contact id, never the provider’s', async () => {
    const outcome = await writeGraphContact({
      userId: USER_ID,
      target: {
        kind: 'graph', connectionId: seeded.connectionId, collectionId: seeded.collectionId,
        target: { kind: 'folder', folderId: 'contacts' }, addressBookId: LOCAL_CONTACT_ID,
      },
      operation: 'update',
      providerContactId: 'AAMkAD-contact-1',
      localResourceId: LOCAL_CONTACT_ID,
      contact: { displayName: 'Ada' },
      providerCalls: { patch: async () => ({ id: 'AAMkAD-contact-1' }) },
    });

    expect(outcome).toMatchObject({ status: 'confirmed', providerContactId: 'AAMkAD-contact-1' });
    expect(await lastOperation()).toMatchObject({
      resource_type: 'contact', operation: 'update', resource_id: LOCAL_CONTACT_ID, status: 'committed',
    });
  });

  it('accepts a create with no local resource yet', async () => {
    const outcome = await writeGraphCalendarEvent({
      userId: USER_ID,
      target: {
        kind: 'graph', connectionId: seeded.connectionId, collectionId: seeded.collectionId,
        providerCalendarId: 'cal-1', calendarId: 'calendar-1',
      },
      operation: 'create',
      event,
      providerCalls: { create: async () => ({ id: 'AAMkAD-new', iCalUId: 'new@contoso.test' }) },
    });

    expect(outcome).toMatchObject({ status: 'confirmed', providerEventId: 'AAMkAD-new' });
    expect(await lastOperation()).toMatchObject({ operation: 'create', resource_id: null, status: 'committed' });
  });
});
