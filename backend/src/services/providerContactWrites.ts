import { query } from './db.js';
import { collectionIsWritable } from './providerAccess.js';
import { runProviderMutation } from './providerMutationService.js';
import { providerWriteFailure, type ProviderWriteFailure } from './providerWriteFailure.js';
import { microsoftConfigFromEnv } from './providerAuthService.js';
import { graphContactMutationAdapter, graphContactPayloadFor } from './providers/microsoft/graphContactWrites.js';
import { contactUidForGraphContact, type GraphContact } from './providers/microsoft/graphContacts.js';
import type { VCardContact } from '../utils/vcard.js';

/**
 * Which writer a local address book's contacts belong to (P09 contacts CRUD).
 *
 * The REST contact routes and the DAV server must agree on this, so the resolution lives in one place.
 * A collection is writable only when the capability model says so — the adapter declares write-through,
 * the **origin** permits writes (`source_access`), and the **user** has enabled them (`user_access`).
 * A source whose write path does not exist in this route is refused here rather than falling through to
 * a local write: a local edit to a provider collection would look like a write-back and be discarded by
 * the next sync, which is exactly what the read-only refusal exists to prevent.
 */

export type ContactWriteTarget =
  | { kind: 'local' }
  | { kind: 'graph'; connectionId: string; collectionId: string; folderId: string; addressBookId: string }
  | { kind: 'refused'; status: number; error: string };

interface ContactTargetRow {
  id: string;
  source: string | null;
  collection_id: string | null;
  remote_id: string | null;
  connection_id: string | null;
  source_access: string | null;
  user_access: string | null;
}

export async function resolveContactWriteTarget(userId: string, addressBookId: string): Promise<ContactWriteTarget> {
  const result = await query<ContactTargetRow>(
    `SELECT ab.id, ab.source, ic.id AS collection_id, ic.remote_id, ic.connection_id,
            ic.source_access, ic.user_access
       FROM address_books ab
       LEFT JOIN integration_collections ic
              ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
      WHERE ab.id = $1 AND ab.user_id = $2`,
    [addressBookId, userId],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'refused', status: 404, error: 'Address book not found' };
  if (!collectionIsWritable({
    source: row.source,
    source_access: row.source_access,
    user_access: row.user_access,
  }, 'contacts')) {
    return { kind: 'refused', status: 403, error: 'This address book is read-only' };
  }
  if ((row.source ?? 'local') === 'local') return { kind: 'local' };
  if (row.source === 'microsoft') {
    if (!row.connection_id || !row.collection_id) {
      return { kind: 'refused', status: 409, error: 'This address book is not linked to a Microsoft connection' };
    }
    return {
      kind: 'graph',
      connectionId: row.connection_id,
      collectionId: row.collection_id,
      folderId: row.remote_id || 'contacts',
      addressBookId: row.id,
    };
  }
  return { kind: 'refused', status: 403, error: 'This contact is synced from an external source and is read-only' };
}

export type ContactWriteOutcome =
  | { status: 'confirmed'; providerContactId: string; contact: GraphContact | null }
  | { status: 'failed'; failure: ProviderWriteFailure };

/** Run one contact write against Graph through the journal, and report what actually happened. */
export async function writeGraphContact(input: {
  userId: string;
  target: Extract<ContactWriteTarget, { kind: 'graph' }>;
  operation: 'create' | 'update' | 'delete';
  providerContactId?: string | null;
  contact?: VCardContact;
  /** Stable key of one logical intent; a distinct autosave is a distinct call. */
  idempotencyKey?: string | null;
}): Promise<ContactWriteOutcome> {
  const api = {
    userId: input.userId,
    connectionId: input.target.connectionId,
    config: microsoftConfigFromEnv(),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: input.operation,
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      resourceId: input.providerContactId ?? null,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: {
        operation: input.operation,
        folderId: input.target.folderId,
        contactId: input.providerContactId ?? null,
        ...(input.contact ? { payload: graphContactPayloadFor(input.contact, input.operation === 'create' ? 'create' : 'update') } : {}),
      },
      timeoutMs: 20_000,
    },
    graphContactMutationAdapter({ api }),
  );
  if (result.status !== 'confirmed') return { status: 'failed', failure: providerWriteFailure(result) };
  const contact = result.value?.contact ?? null;
  const providerContactId = input.providerContactId ?? contact?.id ?? null;
  if (!providerContactId) {
    return {
      status: 'failed',
      failure: { status: 502, error: 'The provider did not identify the saved contact', code: 'CONTACT_ID_MISSING' },
    };
  }
  return { status: 'confirmed', providerContactId, contact };
}

/** Record the provider identity of a newly created local contact, so the next delta updates it. */
export async function recordGraphContactLink(input: {
  userId: string;
  target: Extract<ContactWriteTarget, { kind: 'graph' }>;
  providerContactId: string;
  localId: string;
}): Promise<void> {
  await query(
    `INSERT INTO remote_object_links
       (user_id, connection_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, status)
     VALUES ($1,$2,$3,'contact',$4,$5,$6,$5,'active')
     ON CONFLICT (collection_id, object_remote_id) DO UPDATE SET
       local_id = EXCLUDED.local_id, status = 'active', updated_at = NOW()`,
    [input.userId, input.target.connectionId, input.target.collectionId, input.localId, input.target.folderId, input.providerContactId],
  );
}

/** Tombstone the link of a contact removed at the provider. */
export async function removeGraphContactLink(input: {
  userId: string;
  target: Extract<ContactWriteTarget, { kind: 'graph' }>;
  providerContactId: string;
}): Promise<void> {
  await query(
    `UPDATE remote_object_links SET local_id = NULL, status = 'deleted', updated_at = NOW()
      WHERE collection_id = $1 AND user_id = $2 AND object_remote_id = $3`,
    [input.target.collectionId, input.userId, input.providerContactId],
  );
}

/** The provider contact id a local contact is linked to. */
export async function graphContactIdForLocalRow(userId: string, collectionId: string, localId: string): Promise<string | null> {
  const result = await query<{ object_remote_id: string | null }>(
    `SELECT object_remote_id FROM remote_object_links
      WHERE collection_id = $1 AND user_id = $2 AND local_id = $3 AND object_type = 'contact' AND status = 'active'`,
    [collectionId, userId, localId],
  );
  return result.rows[0]?.object_remote_id ?? null;
}

/** The local uid a provider-created contact must carry so a later sync updates this row. */
export function localUidForGraphContact(providerContactId: string): string {
  return contactUidForGraphContact(providerContactId);
}
