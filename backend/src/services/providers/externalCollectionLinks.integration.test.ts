// Real PostgreSQL: the external-collection link that made the DAV write-back unreachable (P02/P10).
//
// Run against a migrated scratch database:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=... DB_PASSWORD=... \
//   REQUIRE_DAV_POSTGRES=1 npx vitest run src/services/providers/externalCollectionLinks.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'crypto';

import { pool, query } from '../db.js';
import { ensureExternalCollectionLink } from './externalCollectionLinks.js';
import { resolveCollectionAccess } from '../providerAccess.js';

const enabled = process.env.REQUIRE_DAV_POSTGRES === '1';

describe.skipIf(!enabled)('linking an external collection to its source connection (PostgreSQL)', () => {
  const userId = randomUUID();
  const calendarId = randomUUID();
  const addressBookId = randomUUID();
  const carddavUrl = `https://dav.example.test/addressbooks/user-${userId.slice(0, 8)}/`;
  const caldavUrl = `https://dav.example.test/calendars/user-${userId.slice(0, 8)}/`;
  const icsUrl = `https://feeds.example.test/holidays-${userId.slice(0, 8)}.ics`;

  const originalKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    // The source connection stores its URL encrypted, so this suite needs a key the way the OAuth grant
    // suites do.
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [userId, `links-${userId}`, 'unused']);
    // The local collections exist before the link does — this is exactly the pre-existing source the audit
    // found unlinked, so the helper has to find them rather than expect to create them.
    await query(
      `INSERT INTO calendars (id, user_id, owner_user_id, name, color, source, external_url, read_only, dav_mode)
       VALUES ($1, $2, $2, 'Work', '#123456', 'caldav', $3, true, 'off')`,
      [calendarId, userId, `source:${calendarId}`],
    );
    await query(
      `INSERT INTO address_books (id, user_id, name, source, external_url, dav_mode)
       VALUES ($1, $2, 'Contacts', 'carddav', $3, 'off')`,
      [addressBookId, userId, carddavUrl],
    );
  });

  afterAll(async () => {
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    await pool.end();
  });

  it('links a pre-existing CardDAV book as writable at the source, and stays idempotent', async () => {
    const first = await ensureExternalCollectionLink({
      userId, kind: 'carddav', url: carddavUrl, remoteId: carddavUrl, label: 'Contacts', localAddressBookId: addressBookId,
    });
    const second = await ensureExternalCollectionLink({
      userId, kind: 'carddav', url: carddavUrl, remoteId: carddavUrl, label: 'Contacts', localAddressBookId: addressBookId,
    });
    expect(first).toBeTruthy();
    // The same collection on the second pass: one link, not two, which is what a sync doing this every hour
    // depends on.
    expect(second).toBe(first);

    const sources = await query<{ id: string; kind: string }>(
      'SELECT id, kind FROM source_connections WHERE user_id = $1', [userId],
    );
    expect(sources.rows).toHaveLength(1);
    expect(sources.rows[0]?.kind).toBe('carddav');

    const collections = await query<{ id: string; source_access: string; user_access: string; enabled: boolean; local_address_book_id: string | null }>(
      'SELECT id, source_access, user_access, enabled, local_address_book_id FROM integration_collections WHERE user_id = $1', [userId],
    );
    expect(collections.rows).toHaveLength(1);
    expect(collections.rows[0]).toMatchObject({
      source_access: 'read_write',
      // The user has not enabled write-back yet, so the collection is still refused — the link only makes
      // the switch reachable.
      user_access: 'source',
      enabled: true,
      local_address_book_id: addressBookId,
    });
  });

  it('makes the write-back switch reachable and refuses until the user opts in', async () => {
    const collectionId = (await query<{ id: string }>(
      'SELECT id FROM integration_collections WHERE user_id = $1', [userId],
    )).rows[0]?.id;
    expect(collectionId).toBeTruthy();

    const row = {
      source: 'carddav' as const,
      dav_mode: 'read_write' as const,
      source_access: 'read_write' as const,
      user_access: 'source' as const,
    };
    // Before the opt-in the capability model refuses, which is the behaviour a pulled collection must keep.
    expect(resolveCollectionAccess(row, { feature: 'contacts', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }).allowed).toBe(false);

    // `PATCH /api/integrations/collections/:id` records exactly this, and then the external write is admitted.
    await query("UPDATE integration_collections SET user_access = 'read_write' WHERE id = $1", [collectionId]);
    const optedIn = { ...row, user_access: 'read_write' as const };
    expect(resolveCollectionAccess(optedIn, { feature: 'contacts', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }).allowed).toBe(true);
  });

  it('links a CalDAV calendar as writable and an ICS subscription as read-only', async () => {
    await ensureExternalCollectionLink({
      userId, kind: 'caldav', url: caldavUrl, remoteId: `source:${calendarId}`, label: 'Work', localCalendarId: calendarId,
    });
    await ensureExternalCollectionLink({
      userId, kind: 'ical_url', url: icsUrl, remoteId: `source:ics-${calendarId}`, label: 'Holidays',
      localCalendarId: calendarId,
    });

    const rows = await query<{ source_access: string; kind: string }>(
      `SELECT ic.source_access, sc.kind
         FROM integration_collections ic
         JOIN source_connections sc ON sc.id = ic.source_connection_id
        WHERE ic.user_id = $1
        ORDER BY sc.kind`,
      [userId],
    );
    expect(rows.rows.map(row => [row.kind, row.source_access])).toEqual([
      ['caldav', 'read_write'],
      ['carddav', 'read_write'],
      ['ical_url', 'read_only'],
    ]);
  });
});
