import { createHash } from 'crypto';
import { query } from '../db.js';
import { encrypt } from '../encryption.js';

/**
 * The collection link an **external** CalDAV/CardDAV/ICS source needs before its write-back can be
 * enabled (P02's backfill, P10's reachability).
 *
 * P10 forwards a `PUT`/`DELETE` to the source that owns an imported collection, and the capability model
 * admits that write only for a collection whose `integration_collections` row records the origin's own
 * permission and the user's opt-in. Nothing in production created that row: the provider syncs create
 * their own, and the external sources keep their credentials in the tables they have always used
 * (`calendar_import_sources` for CalDAV, `user_integrations` for CardDAV), which is why this module does
 * not touch credentials at all. The row it creates is the link the write-back and the interface both
 * resolve by, and `source_connections` is its schema-required anchor — `integration_collections` demands
 * either a provider connection or a source connection, and an external source is the second case.
 *
 * Two rules keep this from becoming a second source of truth about a user's choices:
 *
 *  1. `source_access` is the **source's** fact — CalDAV and CardDAV accept writes from the client that
 *     owns the account, an ICS subscription does not exist to be written — and is refreshed on each pass;
 *  2. `user_access` and `enabled` are the **user's** and are never overwritten here, so a pass that
 *     happens to run after the user enabled (or disabled) write-back cannot undo that decision.
 */

export type ExternalSourceKind = 'caldav' | 'carddav' | 'ical_url';
export type ExternalCollectionKind = 'calendar' | 'address_book';

/** The fingerprint the schema's unique index keys a source connection on. */
export function externalSourceFingerprint(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

/**
 * What the source itself permits.
 *
 * A CalDAV/CardDAV account belongs to the user and is addressed with the user's own credentials, so the
 * client that imported it may write back. An ICS URL is a read-only publication: it has no write endpoint,
 * so its collection records `read_only` and the capability model refuses a write for it whatever the user
 * selects.
 */
export function externalSourceAccess(kind: ExternalSourceKind): 'read_only' | 'read_write' {
  return kind === 'ical_url' ? 'read_only' : 'read_write';
}

/** The `integration_collections.kind` an external source's local collection has. */
export function externalCollectionKind(kind: ExternalSourceKind): ExternalCollectionKind {
  return kind === 'carddav' ? 'address_book' : 'calendar';
}

/**
 * Find or create the standalone source connection for one external collection URL.
 *
 * `source_connections` has no reader for its credentials because the external sources still hold them;
 * what this row provides is the anchor `integration_collections` requires and a stable identity per URL.
 */
export async function ensureExternalSourceConnection(input: {
  userId: string;
  kind: ExternalSourceKind;
  url: string;
  label?: string | null;
}): Promise<string | null> {
  const fingerprint = externalSourceFingerprint(input.url);
  const existing = await query<{ id: string }>(
    'SELECT id FROM source_connections WHERE user_id = $1 AND url_fingerprint = $2',
    [input.userId, fingerprint],
  );
  if (existing.rows[0]) {
    // The label is cosmetic and refreshed; the kind is not — the same URL cannot be two kinds at once.
    await query(
      'UPDATE source_connections SET label = COALESCE($2, label), updated_at = NOW() WHERE id = $1',
      [existing.rows[0].id, input.label ?? null],
    );
    return existing.rows[0].id;
  }

  try {
    const created = await query<{ id: string }>(
      `INSERT INTO source_connections (user_id, kind, label, url_encrypted, url_fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.userId, input.kind, input.label ?? null, encrypt(input.url), fingerprint],
    );
    if (!created.rows[0]?.id) throw new Error('The source connection could not be created');
    return created.rows[0].id;
  } catch (caught) {
    // A concurrent pass inserted the same URL between the SELECT and the INSERT; the unique index holds,
    // so re-read rather than failing the sync that is merely linking a collection.
    if ((caught as { code?: string }).code !== '23505') throw caught;
    const raced = await query<{ id: string }>(
      'SELECT id FROM source_connections WHERE user_id = $1 AND url_fingerprint = $2',
      [input.userId, fingerprint],
    );
    return raced.rows[0]?.id ?? null;
  }
}

/**
 * Find or create the `integration_collections` link for one external collection.
 *
 * `remoteId` is the identifier the local row already carries (the collection URL, or `source:<id>` for a
 * calendar source), so the link and the local collection cannot drift apart.
 */
export async function ensureExternalCollectionLink(input: {
  userId: string;
  kind: ExternalSourceKind;
  url: string;
  remoteId: string;
  label?: string | null;
  localCalendarId?: string | null;
  localAddressBookId?: string | null;
}): Promise<string | null> {
  const sourceConnectionId = await ensureExternalSourceConnection({
    userId: input.userId, kind: input.kind, url: input.url, label: input.label,
  });
  if (!sourceConnectionId) return null;

  const collectionKind = externalCollectionKind(input.kind);
  const sourceAccess = externalSourceAccess(input.kind);
  const existing = await query<{ id: string; local_calendar_id: string | null; local_address_book_id: string | null }>(
    `SELECT id, local_calendar_id, local_address_book_id FROM integration_collections
      WHERE user_id = $1 AND source_connection_id = $2 AND kind = $3 AND remote_id = $4`,
    [input.userId, sourceConnectionId, collectionKind, input.remoteId],
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    // Re-assert the source's own permission and attach the local row if the link was created without it;
    // `user_access`, `enabled` and `dav_mode` belong to the user and are deliberately left alone.
    const needsLocalLink = (collectionKind === 'calendar' && !row.local_calendar_id && input.localCalendarId)
      || (collectionKind === 'address_book' && !row.local_address_book_id && input.localAddressBookId);
    await query(
      `UPDATE integration_collections
          SET source_access = $2,
              local_calendar_id = COALESCE(local_calendar_id, $3),
              local_address_book_id = COALESCE(local_address_book_id, $4),
              updated_at = NOW()
        WHERE id = $1 AND (source_access IS DISTINCT FROM $2 OR $5)`,
      [row.id, sourceAccess, input.localCalendarId ?? null, input.localAddressBookId ?? null, needsLocalLink],
    );
    return row.id;
  }

  try {
    const created = await query<{ id: string }>(
      `INSERT INTO integration_collections
         (user_id, source_connection_id, kind, remote_id, local_calendar_id, local_address_book_id,
          enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, 'source', 'off')
       RETURNING id`,
      [
        input.userId, sourceConnectionId, collectionKind, input.remoteId,
        input.localCalendarId ?? null, input.localAddressBookId ?? null, sourceAccess,
      ],
    );
    if (!created.rows[0]?.id) throw new Error('The collection link could not be created');
    return created.rows[0].id;
  } catch (caught) {
    if ((caught as { code?: string }).code !== '23505') throw caught;
    const raced = await query<{ id: string }>(
      `SELECT id FROM integration_collections
        WHERE user_id = $1 AND source_connection_id = $2 AND kind = $3 AND remote_id = $4`,
      [input.userId, sourceConnectionId, collectionKind, input.remoteId],
    );
    return raced.rows[0]?.id ?? null;
  }
}
