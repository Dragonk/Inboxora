import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withSavepoint, withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import { generateVCard, parseVCard } from '../../../utils/vcard.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  finishSyncRun,
  readSyncState,
  releaseSyncLease,
  SyncLeaseLostError,
  withFencedSyncLease,
} from '../../syncCoordinator.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { contactUidForGraphContact, DEFAULT_GRAPH_CONTACTS_TARGET, defaultGraphContactFolder, discoverGraphContactFolders, fetchContactsPage, graphContactToVCard } from './graphContacts.js';
import type { GraphContact, GraphContactFolder } from './graphContacts.js';
import { ProviderAuthError, graphGrantCoversScope, REQUIRED_GRAPH_CONTACT_WRITE_SCOPE } from '../../providerAuthService.js';
import { MICROSOFT_GRANT_AUDIENCE } from '../../providerAuthService.js';
import { readGrantForUser } from '../../providerTokenService.js';
import type { FetchLike } from '../../providerAuthService.js';

/**
 * Microsoft Graph contacts sync (P07/P09, read path).
 *
 * Outlook's default contact folder is addressed by its well-known name, so a
 * renamed folder still syncs. Contacts are linked by the Graph contact id; the
 * e-mail address is never a key. A delta cursor keeps later runs incremental, and a
 * cursor Graph rejects (HTTP 410) rebuilds from a baseline **and reconciles**: a
 * plain re-read would miss whatever was deleted while the cursor was unusable.
 */

export const GRAPH_CONTACTS_BOOK_NAME = 'Microsoft Contacts';
/** The well-known name of Outlook's default contact folder. */
export const GRAPH_CONTACTS_FOLDER = 'contacts';
const MAX_PAGES = 1000;
const PAGE_SIZE = 200;

export interface GraphContactsSyncResult extends GraphContactsFolderResult {
  /**
   * Every contact folder this run synchronised, the mailbox's default folder first (GRAPH-03).
   *
   * A mailbox has more than one contact folder, and a contact in any of them is invisible while only the default
   * one is pulled. Each folder becomes its own local address book, with its own cursor and its own `enabled` and
   * write-back choices.
   */
  books: GraphContactsFolderResult[];
  /**
   * Additional folders whose run failed. The default folder's failure is thrown instead — it is the mailbox's
   * own contacts and a silent success would report a mailbox that pulled nothing as healthy — while one extra
   * folder must not stop the others (the rule GRAPH-06 established for mail folders).
   */
  errors: Array<{ folderId: string; code: string; stage: 'discovery' | 'provider-request' | 'decode-contact' | 'db-project' | 'reconcile' | 'checkpoint'; status?: number; providerReason?: string }>;
}

/** One folder's outcome. */
export interface GraphContactsFolderResult {
  addressBookId: string;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSync: boolean;
  cursor: string | null;
  /** The delta did not reach its end within one run; the local book is a prefix, not the book (SYNC-04). */
  incomplete: boolean;
  /** The collection is disabled by the user, so nothing was pulled (SYNC-09). */
  disabled: boolean;
}

interface ApplyContext {
  userId: string;
  connectionId: string;
  addressBookId: string;
  collectionId: string;
  /** The provider's contact-folder id this collection mirrors, so a link names the folder it came from. */
  collectionRemoteId: string;
}

/**
 * What the granted Graph permission actually permits for this connection.
 *
 * A connection authorized for `Contacts.Read` can be read and nothing else, while `Contacts.ReadWrite`
 * (or a variant of it) is the consent the write path needs. Recording this is what lets the per-collection
 * write-back switch be offered at all: the capability model refuses to enable write-back on a collection
 * whose source is marked read-only, and a blanket `read_only` here made every Microsoft address book
 * unreachable for writing even when the grant allowed it. `user_access` still starts at `source`, so the
 * user's own opt-in remains a separate decision.
 */
async function graphContactSourceAccess(client: PoolClient, userId: string, connectionId: string): Promise<'read_only' | 'read_write'> {
  try {
    // The caller's own client: this runs inside the transaction that creates or finds the link, and opening
    // a second one for one `SELECT` would take a pool connection per sync for no reason.
    const grant = await readGrantForUser(client, { userId, connectionId, audience: MICROSOFT_GRANT_AUDIENCE });
    return grant && graphGrantCoversScope(grant.scopes, REQUIRED_GRAPH_CONTACT_WRITE_SCOPE) ? 'read_write' : 'read_only';
  } catch {
    // A transient read failure must not be recorded as a permission the connection may not have.
    return 'read_only';
  }
}

/** Find or create the local address book and collection link for a connection. */
export async function ensureGraphAddressBook(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  label?: string;
  /**
   * The provider's **real** contact-folder id (GRAPH-03). Falls back to the legacy literal only for callers that
   * predate discovery; `syncGraphContacts` always passes the discovered id, because the literal is not a folder
   * id Graph can resolve.
   */
  folderId?: string;
}): Promise<{ addressBookId: string; collectionId: string }> {
  const sourceAccess = await graphContactSourceAccess(client, input.userId, input.connectionId);
  const remoteId = input.folderId?.trim() || GRAPH_CONTACTS_FOLDER;
  const linkQuery = `SELECT id, local_address_book_id FROM integration_collections
     WHERE connection_id = $1 AND kind = 'address_book' AND remote_id = $2`;
  let existing = await client.query<{ id: string; local_address_book_id: string | null }>(
    linkQuery,
    [input.connectionId, remoteId],
  );
  // A historical literal `contacts` does not prove which modern target it was
  // intended to represent. Do not transfer its cursor, contacts or write-back choice
  // to the default collection or to the first discovered folder without provider-side
  // evidence; a later dedicated adoption flow may bind it explicitly.
  if (existing.rows[0]?.local_address_book_id) {
    // Already linked: refresh the source's own permission, which is what repairs a collection created
    // before this was recorded, and never touch `user_access` or `enabled` — those are the user's.
    await client.query(
      `UPDATE integration_collections SET source_access = $2, updated_at = NOW()
        WHERE id = $1 AND source_access IS DISTINCT FROM $2`,
      [existing.rows[0].id, sourceAccess],
    );
    return { addressBookId: existing.rows[0].local_address_book_id, collectionId: existing.rows[0].id };
  }

  const label = input.label?.trim() || GRAPH_CONTACTS_BOOK_NAME;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? label : `${label} (${attempt + 1})`;
    try {
      // Each attempt runs under its own savepoint, so a `23505` on the local book name can actually be retried
      // instead of aborting the transaction with `25P02` (DB-01).
      return await withSavepoint(client, `graph_book_${attempt}`, async () => {
        const created = await client.query<{ id: string }>(
          // A provider book starts hidden from DAV devices (plan §17.1).
          `INSERT INTO address_books (user_id, name, source, dav_mode) VALUES ($1, $2, 'microsoft', 'off') RETURNING id`,
          [input.userId, name],
        );
        const addressBookId = created.rows[0]?.id;
        if (!addressBookId) throw new Error('Could not create the Microsoft address book');

        if (existing.rows[0]) {
          // Link the book to the row that exists, without re-asserting `enabled`: a user who
          // disabled this collection must not have a sync switch it back on.
          await client.query(
            `UPDATE integration_collections
                SET local_address_book_id = $2, source_access = $3, updated_at = NOW()
              WHERE id = $1`,
            [existing.rows[0].id, addressBookId, sourceAccess],
          );
          return { addressBookId, collectionId: existing.rows[0].id };
        }

        const collection = await client.query<{ id: string }>(
          `INSERT INTO integration_collections
             (user_id, connection_id, kind, remote_id, local_address_book_id, enabled, source_access, user_access, dav_mode)
           VALUES ($1, $2, 'address_book', $3, $4, true, $5, 'source', 'off')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [input.userId, input.connectionId, remoteId, addressBookId, sourceAccess],
        );
        const collectionId = collection.rows[0]?.id
          ?? (await client.query<{ id: string }>(linkQuery, [input.connectionId, remoteId])).rows[0]?.id;
        if (!collectionId) throw new Error('Could not link the Microsoft address book');
        return { addressBookId, collectionId };
      });
    } catch (caught) {
      if (toAppError(caught).code === '23505') continue; // name taken — try the next suffix
      throw caught;
    }
  }
  throw new Error('Could not create the Microsoft address book');
}

async function upsertLink(client: PoolClient, context: ApplyContext, remoteId: string, input: {
  localId: string | null;
  changeKey: string | null;
  status: 'active' | 'deleted';
}): Promise<void> {
  await client.query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
     VALUES ($1,$2,$3,'contact',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, remote_version = EXCLUDED.remote_version,
       status = EXCLUDED.status, updated_at = NOW()`,
    [
      context.userId, context.connectionId, context.collectionId, input.localId,
      context.collectionRemoteId, remoteId, context.collectionRemoteId, input.changeKey, input.status,
    ],
  );
}

/** Insert or update one local contact and its remote link. */
async function applyContact(client: PoolClient, context: ApplyContext, contact: GraphContact): Promise<'created' | 'updated' | 'skipped'> {
  if (!contact.id) return 'skipped';
  const uid = contactUidForGraphContact(contact.id);
  const card = graphContactToVCard(contact, uid);
  const vcard = generateVCard(card);
  const parsed = parseVCard(vcard);
  const etag = crypto.createHash('sha256').update(vcard).digest('hex');
  const primaryEmail = (parsed.emails.find(email => email.primary) || parsed.emails[0])?.value?.toLowerCase() || null;

  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, contact.id],
  );
  let localId = link.rows[0]?.local_id ?? null;

  if (localId) {
    const updated = await client.query(
      `UPDATE contacts SET
         vcard = $1, etag = $2, display_name = $3, first_name = $4, last_name = $5,
         primary_email = $6, emails = $7::jsonb, phones = $8::jsonb, organization = $9, notes = $10,
         birthday = $11, anniversary = COALESCE($12, anniversary), contact_dates = $13::jsonb, photo_data = $14,
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
         notes = EXCLUDED.notes, birthday = EXCLUDED.birthday,
         -- Graph v1.0 has no anniversary property, so the sync has nothing to say about it; a value the user
         -- or another source stored must survive the upsert rather than being cleared (GRAPH-03).
         anniversary = COALESCE(EXCLUDED.anniversary, contacts.anniversary),
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

  await upsertLink(client, context, contact.id, { localId, changeKey: null, status: 'active' });
  return outcome;
}

/** Remove the local contact a deleted contact is linked to. */
async function deleteContact(client: PoolClient, context: ApplyContext, remoteId: string): Promise<boolean> {
  const link = await client.query<{ id: string; local_id: string | null }>(
    `SELECT id, local_id FROM remote_object_links WHERE collection_id = $1 AND object_remote_id = $2`,
    [context.collectionId, remoteId],
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
 * Apply one delta page. `seenRemoteIds` collects what the provider still lists, so
 * a rebuilt baseline can remove what it no longer mentions.
 */
export async function applyGraphContactsPage(client: PoolClient, context: ApplyContext, contacts: readonly GraphContact[], seenRemoteIds?: Set<string>): Promise<{
  created: number; updated: number; deleted: number; skipped: number;
}> {
  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  for (const contact of contacts) {
    if (!contact.id) { totals.skipped += 1; continue; }
    if (contact.removed) {
      if (await deleteContact(client, context, contact.id)) totals.deleted += 1;
      else totals.skipped += 1;
      continue;
    }
    seenRemoteIds?.add(contact.id);
    const outcome = await applyContact(client, context, contact);
    if (outcome === 'created') totals.created += 1;
    else if (outcome === 'updated') totals.updated += 1;
    else totals.skipped += 1;
  }
  return totals;
}

/**
 * Remove local contacts that the rebuilt baseline did not list. Only used after a
 * full baseline: during an incremental delta the provider reports deletions
 * explicitly, and anything absent is simply unchanged.
 */
export async function reconcileGraphContacts(client: PoolClient, context: ApplyContext, seenRemoteIds: ReadonlySet<string>): Promise<number> {
  const links = await client.query<{ id: string; object_remote_id: string; local_id: string | null }>(
    `SELECT id, object_remote_id, local_id FROM remote_object_links
      WHERE collection_id = $1 AND object_type = 'contact' AND status = 'active'`,
    [context.collectionId],
  );
  let removed = 0;
  for (const link of links.rows) {
    if (seenRemoteIds.has(link.object_remote_id)) continue;
    if (link.local_id) await client.query('DELETE FROM contacts WHERE id = $1 AND user_id = $2', [link.local_id, context.userId]);
    await client.query(
      `UPDATE remote_object_links SET status = 'deleted', local_id = NULL, updated_at = NOW() WHERE id = $1`,
      [link.id],
    );
    removed += 1;
  }
  return removed;
}

/** The per-folder half of the sync: one discovered contact folder into its own local address book. */
async function syncGraphContactFolder(input: {
  userId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  label?: string;
  fetchImpl?: FetchLike;
  /** The page cap for one delta; injectable so the "limited run is not complete" path is provable. */
  maxPages?: number;
}, folder: GraphContactFolder, owner: string, api: GraphApiOptions): Promise<GraphContactsFolderResult> {
  const ensured = await withTransaction(client => ensureGraphAddressBook(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    label: input.label ?? folder.displayName ?? undefined,
    folderId: folder.id,
  }));
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    feature: 'contacts',
    collectionId: ensured.collectionId,
    coverage: 'personal',
  }));

  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GraphApiError({
      code: 'SYNC_ALREADY_RUNNING',
      message: 'Another Microsoft contacts sync is already running for this connection',
      status: 409,
      retryable: true,
    });
  }

  const context: ApplyContext = {
    userId: input.userId,
    connectionId: input.connectionId,
    addressBookId: ensured.addressBookId,
    collectionId: ensured.collectionId,
    collectionRemoteId: folder.id,
  };

  try {
    // SYNC-09: a collection the user disabled is not pulled, on a manual run as well as on the schedule.
    const collectionState = await withTransaction(client => client.query<{ enabled: boolean }>(
      'SELECT enabled FROM integration_collections WHERE id = $1 AND user_id = $2',
      [ensured.collectionId, input.userId],
    ));
    if (collectionState.rows[0]?.enabled === false) {
      await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
      return { addressBookId: ensured.addressBookId, created: 0, updated: 0, deleted: 0, skipped: 0, fullSync: false, cursor: null, incomplete: false, disabled: true };
    }

    const state = await withTransaction(client => readSyncState(client, syncStateId));
    let cursor = state?.cursor ?? null;
    let fullSync = cursor === null;
    let nextLink: string | null = null;
    let deltaLink: string | null = null;
    // Only a baseline needs the seen-set: a delta reports deletions explicitly.
    const seen = new Set<string>();
    const totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
    let complete = false;

    for (let page = 0; page < (input.maxPages ?? MAX_PAGES); page++) {
      let fetched;
      try {
        fetched = await fetchContactsPage(api, {
          ...(folder.id === DEFAULT_GRAPH_CONTACTS_TARGET ? { defaultContacts: true } : { folderId: folder.id }),
          nextLink, deltaLink: nextLink ? null : cursor, top: PAGE_SIZE,
        });
      } catch (caught) {
        // The delta token expired: rebuild from a baseline instead of failing.
        if (caught instanceof GraphApiError && caught.code === 'INVALID_SYNC_CURSOR' && cursor) {
          cursor = null;
          nextLink = null;
          fullSync = true;
          seen.clear();
          continue;
        }
        throw caught;
      }
      if (page === 0 && cursor === null) fullSync = true;
      const applied = await withFencedSyncLease({ syncStateId, generation: lease.generation, run: client => applyGraphContactsPage(client, context, fetched.contacts, seen) });
      totals.created += applied.created;
      totals.updated += applied.updated;
      totals.deleted += applied.deleted;
      totals.skipped += applied.skipped;

      if (fetched.deltaLink) deltaLink = fetched.deltaLink;
      nextLink = fetched.nextLink;
      if (!nextLink) { complete = true; break; }
    }

    if (!complete) {
      // The page cap was reached before the delta ended. Reconciling deletions against a prefix would remove
      // contacts that were merely not read yet, and storing a cursor would skip the rest for ever (SYNC-04). The
      // stored cursor is left as it is and the run does not claim a successful synchronisation.
      await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
      return { addressBookId: ensured.addressBookId, ...totals, fullSync, cursor, incomplete: true, disabled: false };
    }

    if (fullSync) {
      // A baseline lists everything that still exists, so anything else is gone.
      const removed = await withFencedSyncLease({ syncStateId, generation: lease.generation, run: client => reconcileGraphContacts(client, context, seen) });
      totals.deleted += removed;
    }

    const finalCursor = deltaLink ?? cursor;
    const committed = await withTransaction(async client => {
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        cursor: finalCursor,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      // Every page was applied, so the run completed its declared scope (SYNC-02).
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
    if (!committed) {
      throw new GraphApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the cursor could be stored',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return { addressBookId: ensured.addressBookId, ...totals, fullSync, cursor: finalCursor, incomplete: false, disabled: false };
  } catch (caught) {
    const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * Synchronise every contact folder of one connection.
 *
 * GRAPH-03: the folders are **discovered** — the sync used to address one as the literal `contacts`, which is not
 * a folder id Graph resolves (`contactFolder` has no well-known-name property, unlike the `mailFolder` whose
 * similar assumption had to be removed under GRAPH-01) — and each one is pulled into its own local address book,
 * so a contact is visible wherever the mailbox keeps it.
 *
 * The default folder runs first and its failure is thrown: it holds the mailbox's own contacts, and reporting a
 * mailbox that pulled nothing as healthy would be worse than the error. A failure in any **additional** folder is
 * recorded in `errors` and the remaining folders still run, which is the isolation GRAPH-06 established for mail
 * folders.
 */
export async function syncGraphContacts(input: {
  userId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  label?: string;
  fetchImpl?: FetchLike;
  owner?: string;
  /** The page cap for one delta; injectable so the "limited run is not complete" path is provable. */
  maxPages?: number;
}): Promise<GraphContactsSyncResult> {
  const owner = input.owner ?? `graph-contacts:${input.connectionId}`;
  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  // The default collection is independent from contact-folder discovery. A broken
  // child branch must not prevent the documented `/me/contacts` read from running.
  const errors: GraphContactsSyncResult['errors'] = [];
  let discovered: GraphContactFolder[] = [];
  try {
    discovered = await discoverGraphContactFolders(api);
  } catch (caught) {
    const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError
      ? caught.code : 'INTERNAL_ERROR';
    errors.push({ folderId: 'discovery', code, stage: 'discovery', ...(caught instanceof GraphApiError ? { status: caught.status, providerReason: caught.providerReason } : {}) });
    console.warn(`Microsoft contacts folder discovery failed for connection ${input.connectionId}:`, code);
  }
  // `/me/contacts` is the mailbox's default contact folder, not an
  // additional book. Prefer the discovered real folder id so one remote person
  // cannot be projected twice. Only fall back to the well-known collection when
  // discovery itself yielded no usable default; that fallback has a distinct
  // sentinel and is never conflated with a guessed folder id.
  const discoveredDefault = defaultGraphContactFolder(discovered);
  const primary: GraphContactFolder = discoveredDefault
    ?? { id: DEFAULT_GRAPH_CONTACTS_TARGET, displayName: GRAPH_CONTACTS_BOOK_NAME };
  const discoveredFolders = discovered.filter((folder, index, all) =>
    all.findIndex(candidate => candidate.id === folder.id) === index,
  );
  // If discovery returned only nested folders, retain them as independent
  // collections while still using the well-known default fallback. An incomplete
  // discovery must not make known folders silently disappear.
  const ordered = discoveredDefault ? discoveredFolders : [primary, ...discoveredFolders];
  const books: GraphContactsFolderResult[] = [];
  for (const folder of ordered) {
    try {
      const result = await syncGraphContactFolder(
        folder.id === primary.id ? input : { ...input, label: undefined },
        folder,
        // A distinct owner per folder keeps the lease keyed to the collection's own sync state, so two folders of
        // one connection cannot appear as each other's concurrent run.
        `${owner}:${folder.id}`,
        api,
      );
      books.push(result);
    } catch (caught) {
      const db = toAppError(caught);
      const emailCollision = db.code === '23505' && db.constraint === 'contacts_book_primary_email_idx';
      // Preserve distinct provider identities: only the historical address-book
      // e-mail constraint is diagnosed this way. Other integrity violations keep
      // their own failure code rather than being misreported as an e-mail clash.
      const code = emailCollision ? 'CONTACT_EMAIL_COLLISION' : caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError
        ? caught.code : 'INTERNAL_ERROR';
      if (folder.id === primary.id) throw caught;
      errors.push({
        folderId: folder.id, code, stage: emailCollision ? 'db-project' : 'provider-request',
        ...(caught instanceof GraphApiError ? { status: caught.status, providerReason: caught.providerReason } : {}),
      });
      console.warn(`Microsoft contacts sync failed for folder ${folder.id} of connection ${input.connectionId}:`, code);
    }
  }

  const totals = books.reduce((sum, book) => ({
    created: sum.created + book.created,
    updated: sum.updated + book.updated,
    deleted: sum.deleted + book.deleted,
    skipped: sum.skipped + book.skipped,
  }), { created: 0, updated: 0, deleted: 0, skipped: 0 });
  // The first book is the discovered default folder when discovery succeeded,
  // or the explicit `/me/contacts` fallback when it did not.
  const primaryBook = books[0];
  return {
    addressBookId: primaryBook?.addressBookId ?? '',
    ...totals,
    // The run is complete when every folder that ran reached the end of its delta; a folder that failed is not
    // a completed folder, so its book's state is not claimed as synchronised either.
    fullSync: books.length > 0 && books.every(book => book.fullSync),
    cursor: primaryBook?.cursor ?? null,
    incomplete: books.some(book => book.incomplete) || errors.length > 0,
    disabled: books.length > 0 && books.every(book => book.disabled),
    books,
    errors,
  };
}
