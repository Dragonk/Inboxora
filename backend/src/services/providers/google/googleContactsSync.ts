import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import { generateVCard, parseVCard } from '../../../utils/vcard.js';
import type { VCardContact } from '../../../utils/vcard.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  readSyncState,
  releaseSyncLease,
} from '../../syncCoordinator.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { fetchConnectionsPage, personToVCardContact } from './googlePeople.js';
import type { GooglePerson } from './googlePeople.js';
import { ProviderAuthError } from '../../providerAuthService.js';
import type { FetchLike, GoogleConfig } from '../../providerAuthService.js';

/**
 * Google People contacts sync (P09, read path).
 *
 * Personal connections are projected into one local address book per provider
 * connection. The provider resource name is the identity: it links the local
 * contact to the remote person through `remote_object_links`, so a renamed
 * contact or a shared e-mail address never merges or duplicates a record.
 *
 * The address book is created with `dav_mode = 'off'` and its source is not
 * `local`, so the REST and DAV write paths refuse to edit it — the source is the
 * writer until write-through lands. The sync cursor is stored under the P03
 * lease, so a restarted worker cannot advance it out of order.
 */

export const GOOGLE_CONTACTS_BOOK_NAME = 'Google Contacts';
/** One personal-contacts collection per connection. */
export const GOOGLE_PERSONAL_COLLECTION_REMOTE_ID = 'people/me';
const MAX_PAGES = 1000;
const APPLY_PAGE_SIZE = 500;

export interface GoogleContactsSyncResult {
  addressBookId: string;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSync: boolean;
  cursor: string | null;
}

/** Stable local identity derived from the People resource name, never the e-mail. */
export function contactUidForPerson(resourceName: string): string {
  const id = resourceName.split('/').filter(Boolean).pop() ?? resourceName;
  return `google-${id}`;
}

/**
 * Find or create the local address book and its collection link for a connection.
 * A name collision gets a numeric suffix, like the external CardDAV importer, so a
 * user-created "Google Contacts" book is never overwritten.
 */
export async function ensureGoogleAddressBook(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  label?: string;
}): Promise<{ addressBookId: string; collectionId: string }> {
  const linkQuery = `SELECT id, local_address_book_id FROM integration_collections
     WHERE connection_id = $1 AND kind = 'address_book' AND remote_id = $2`;
  const existing = await client.query<{ id: string; local_address_book_id: string | null }>(
    linkQuery,
    [input.connectionId, GOOGLE_PERSONAL_COLLECTION_REMOTE_ID],
  );
  if (existing.rows[0]?.local_address_book_id) {
    // Already linked. The provider's own permission is refreshed — the People API lets the signed-in
    // user modify their own contacts, so this collection is writable at the source — while `enabled` and
    // `user_access` stay exactly as the user left them.
    await client.query(
      `UPDATE integration_collections SET source_access = 'read_write', updated_at = NOW()
        WHERE id = $1 AND source_access IS DISTINCT FROM 'read_write'`,
      [existing.rows[0].id],
    );
    return { addressBookId: existing.rows[0].local_address_book_id, collectionId: existing.rows[0].id };
  }

  const label = input.label?.trim() || GOOGLE_CONTACTS_BOOK_NAME;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? label : `${label} (${attempt + 1})`;
    try {
      const created = await client.query<{ id: string }>(
        // A new provider book starts hidden from DAV devices (plan §17.1).
        `INSERT INTO address_books (user_id, name, source, dav_mode) VALUES ($1, $2, 'google', 'off') RETURNING id`,
        [input.userId, name],
      );
      const addressBookId = created.rows[0]?.id;
      if (!addressBookId) throw new Error('Could not create the Google address book');

      if (existing.rows[0]) {
        // Link the book to the row that exists, without re-asserting `enabled`: a user who
        // disabled this collection must not have a sync switch it back on. `source_access` is the
        // provider's fact, so it is set to this source's answer.
        await client.query(
          `UPDATE integration_collections
              SET local_address_book_id = $2, source_access = 'read_write', updated_at = NOW()
            WHERE id = $1`,
          [existing.rows[0].id, addressBookId],
        );
        return { addressBookId, collectionId: existing.rows[0].id };
      }

      const collection = await client.query<{ id: string }>(
        `INSERT INTO integration_collections
           (user_id, connection_id, kind, remote_id, local_address_book_id, enabled, source_access, user_access, dav_mode)
         VALUES ($1, $2, 'address_book', $3, $4, true, 'read_write', 'source', 'off')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [input.userId, input.connectionId, GOOGLE_PERSONAL_COLLECTION_REMOTE_ID, addressBookId],
      );
      const collectionId = collection.rows[0]?.id
        ?? (await client.query<{ id: string }>(linkQuery, [input.connectionId, GOOGLE_PERSONAL_COLLECTION_REMOTE_ID])).rows[0]?.id;
      if (!collectionId) throw new Error('Could not link the Google address book');
      return { addressBookId, collectionId };
    } catch (caught) {
      if (toAppError(caught).code === '23505') continue; // name taken — try the next suffix
      throw caught;
    }
  }
  throw new Error('Could not create the Google address book');
}

interface ApplyContext {
  userId: string;
  connectionId: string;
  addressBookId: string;
  collectionId: string;
}

/** Insert or update one local contact and its remote link. */
async function applyPerson(client: PoolClient, context: ApplyContext, person: GooglePerson): Promise<'created' | 'updated' | 'skipped'> {
  if (!person.resourceName) return 'skipped';
  const uid = contactUidForPerson(person.resourceName);
  const contact: VCardContact = personToVCardContact(person, uid);
  const vcard = generateVCard(contact);
  const parsed = parseVCard(vcard);
  const etag = crypto.createHash('sha256').update(vcard).digest('hex');
  const primaryEmail = (parsed.emails.find(email => email.primary) || parsed.emails[0])?.value?.toLowerCase() || null;

  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, person.resourceName],
  );
  let localId = link.rows[0]?.local_id ?? null;

  if (localId) {
    const updated = await client.query(
      `UPDATE contacts SET
         vcard = $1, etag = $2, display_name = $3, first_name = $4, last_name = $5,
         primary_email = $6, emails = $7::jsonb, phones = $8::jsonb, organization = $9, notes = $10,
         birthday = $11, anniversary = $12, contact_dates = $13::jsonb, photo_data = $14,
         title = $15, role = $16, nickname = $17, urls = $18::jsonb, instant_messages = $19::jsonb,
         categories = $20::jsonb, addresses = $21::jsonb, is_auto = false, updated_at = NOW()
       WHERE id = $22 AND user_id = $23
       RETURNING id`,
      [
        vcard, etag, parsed.displayName, parsed.firstName, parsed.lastName, primaryEmail,
        JSON.stringify(parsed.emails), JSON.stringify(parsed.phones), parsed.organization, parsed.notes,
        parsed.birthday, parsed.anniversary, JSON.stringify(parsed.contactDates), parsed.photoData,
        parsed.title, parsed.role, parsed.nickname, JSON.stringify(parsed.urls), JSON.stringify(parsed.instantMessages),
        JSON.stringify(parsed.categories), JSON.stringify(parsed.addresses), localId, context.userId,
      ],
    );
    // A contact deleted locally is recreated from the source on the next sync.
    if (!updated.rows.length) localId = null;
  }

  let outcome: 'created' | 'updated' = 'updated';
  if (!localId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO contacts (
         address_book_id, user_id, uid, vcard, etag, display_name, first_name, last_name, primary_email,
         emails, phones, organization, notes, birthday, anniversary, contact_dates, photo_data,
         title, role, nickname, urls, instant_messages, categories, addresses, is_auto
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,false)
       ON CONFLICT (address_book_id, uid) DO UPDATE SET
         vcard = EXCLUDED.vcard, etag = EXCLUDED.etag, display_name = EXCLUDED.display_name,
         first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, primary_email = EXCLUDED.primary_email,
         emails = EXCLUDED.emails, phones = EXCLUDED.phones, organization = EXCLUDED.organization,
         notes = EXCLUDED.notes, birthday = EXCLUDED.birthday, anniversary = EXCLUDED.anniversary,
         contact_dates = EXCLUDED.contact_dates, photo_data = EXCLUDED.photo_data, title = EXCLUDED.title,
         role = EXCLUDED.role, nickname = EXCLUDED.nickname, urls = EXCLUDED.urls,
         instant_messages = EXCLUDED.instant_messages, categories = EXCLUDED.categories,
         addresses = EXCLUDED.addresses, is_auto = false, updated_at = NOW()
       RETURNING id`,
      [
        context.addressBookId, context.userId, uid, vcard, etag, parsed.displayName, parsed.firstName, parsed.lastName, primaryEmail,
        JSON.stringify(parsed.emails), JSON.stringify(parsed.phones), parsed.organization, parsed.notes,
        parsed.birthday, parsed.anniversary, JSON.stringify(parsed.contactDates), parsed.photoData,
        parsed.title, parsed.role, parsed.nickname, JSON.stringify(parsed.urls), JSON.stringify(parsed.instantMessages),
        JSON.stringify(parsed.categories), JSON.stringify(parsed.addresses),
      ],
    );
    localId = inserted.rows[0]?.id ?? null;
    if (!localId) return 'skipped';
    outcome = link.rows[0] ? 'updated' : 'created';
  }

  await client.query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
     VALUES ($1,$2,$3,'contact',$4,$5,$6,$7,$8,'active')
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, remote_href = EXCLUDED.remote_href,
       remote_version = EXCLUDED.remote_version, status = 'active', updated_at = NOW()`,
    [
      context.userId, context.connectionId, context.collectionId, localId,
      GOOGLE_PERSONAL_COLLECTION_REMOTE_ID, person.resourceName,
      GOOGLE_PERSONAL_COLLECTION_REMOTE_ID, person.etag ?? null,
    ],
  );
  return outcome;
}

/** Remove the local contact a deleted/unsynced person is linked to. */
async function deletePerson(client: PoolClient, context: ApplyContext, resourceName: string): Promise<boolean> {
  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, resourceName],
  );
  const row = link.rows[0];
  if (!row) return false;
  if (row.local_id) {
    await client.query('DELETE FROM contacts WHERE id = $1 AND user_id = $2', [row.local_id, context.userId]);
  }
  await client.query(
    `UPDATE remote_object_links SET status = 'deleted', local_id = NULL, updated_at = NOW() WHERE id = $1`,
    [row.id],
  );
  return true;
}

/**
 * Apply one page of people. Exported so the behaviour can be exercised directly:
 * a full sync and an incremental one use the same path.
 */
export async function applyGooglePeoplePage(client: PoolClient, context: ApplyContext, people: readonly GooglePerson[]): Promise<{
  created: number; updated: number; deleted: number; skipped: number;
}> {
  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  for (const person of people) {
    if (person.metadata?.deleted) {
      if (await deletePerson(client, context, person.resourceName)) totals.deleted += 1;
      else totals.skipped += 1;
      continue;
    }
    const outcome = await applyPerson(client, context, person);
    if (outcome === 'created') totals.created += 1;
    else if (outcome === 'updated') totals.updated += 1;
    else totals.skipped += 1;
  }
  return totals;
}

/**
 * Synchronise the personal contacts of one Google connection.
 *
 * A fresh sync requests a sync token and stores it as the cursor; later runs send
 * that cursor and only receive changes. An expired cursor (HTTP 410) reconciles
 * from scratch instead of failing the run — the local projection is never deleted
 * up front, and every apply is an idempotent upsert keyed by resource name.
 */
export async function syncGoogleContacts(input: {
  userId: string;
  connectionId: string;
  config: GoogleConfig;
  label?: string;
  fetchImpl?: FetchLike;
  owner?: string;
}): Promise<GoogleContactsSyncResult> {
  const ensured = await withTransaction(client => ensureGoogleAddressBook(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    label: input.label,
  }));
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    feature: 'contacts',
    collectionId: ensured.collectionId,
    coverage: 'personal',
  }));

  const owner = input.owner ?? `google-contacts:${input.connectionId}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GoogleApiError({
      code: 'RATE_LIMITED',
      message: 'Another Google contacts sync is already running for this connection',
      status: 409,
      retryable: true,
    });
  }

  const api: GoogleApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    config: input.config,
    owner,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const context: ApplyContext = {
    userId: input.userId,
    connectionId: input.connectionId,
    addressBookId: ensured.addressBookId,
    collectionId: ensured.collectionId,
  };

  try {
    const state = await withTransaction(client => readSyncState(client, syncStateId));
    let cursor = state?.cursor ?? null;
    let fullSync = cursor === null;
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;
    const totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };

    for (let page = 0; page < MAX_PAGES; page++) {
      let fetched;
      try {
        fetched = await fetchConnectionsPage(api, { pageToken, syncToken: cursor, pageSize: APPLY_PAGE_SIZE });
      } catch (caught) {
        // A cursor the provider no longer accepts means history was lost: rebuild
        // this collection from a fresh baseline rather than failing forever.
        if (caught instanceof GoogleApiError && caught.code === 'INVALID_SYNC_CURSOR' && cursor) {
          cursor = null;
          pageToken = null;
          fullSync = true;
          continue;
        }
        throw caught;
      }

      const applied = await withTransaction(client => applyGooglePeoplePage(client, context, fetched.people));
      totals.created += applied.created;
      totals.updated += applied.updated;
      totals.deleted += applied.deleted;
      totals.skipped += applied.skipped;

      if (fetched.nextSyncToken) nextSyncToken = fetched.nextSyncToken;
      pageToken = fetched.nextPageToken;
      if (!pageToken) break;
    }

    // The cursor advances only after every page was applied, so a crash mid-run
    // re-reads from the previous cursor instead of skipping changes.
    const finalCursor = nextSyncToken ?? cursor;
    const committed = await withTransaction(client => commitSyncCheckpoint(client, {
      syncStateId,
      generation: lease.generation,
      cursor: finalCursor,
      clearPageCheckpoint: true,
      lastErrorCode: null,
    }));
    if (!committed) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the cursor could be stored',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});

    return { addressBookId: ensured.addressBookId, ...totals, fullSync, cursor: finalCursor };
  } catch (caught) {
    const code = caught instanceof GoogleApiError || caught instanceof ProviderAuthError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}
