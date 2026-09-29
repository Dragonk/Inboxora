import { createHash } from 'node:crypto';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import { query, withTransaction } from './db.js';
import { graphGrantCoversScope, MICROSOFT_GRANT_AUDIENCE, REQUIRED_GRAPH_CONTACT_WRITE_SCOPE } from './providerAuthService.js';
import { readGrantForUser } from './providerTokenService.js';
import { collectionIsWritable } from './providerAccess.js';
import { runProviderMutation, type ProviderMutationResult } from './providerMutationService.js';
import { assertContactDiscoveryAuthorized, retireAddressBookCollection } from './addressBookCollectionFence.js';
import { GraphApiError, type GraphApiOptions } from './providers/microsoft/graphApiClient.js';
import { deleteGraphAddressBook, GraphAddressBookProtectionError, inspectGraphAddressBookDeletion } from './providers/microsoft/graphContactsManagement.js';
import { discoverGraphContactFolders } from './providers/microsoft/graphContacts.js';
import { acquireSyncLease, ensureSyncState, releaseSyncLease, withFencedSyncLease } from './syncCoordinator.js';

export class AddressBookCollectionError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
interface Book {
  id: string; name: string; source: string; collection_id: string | null; remote_id: string | null;
  connection_id: string | null; account_id: string | null; source_access: string | null; user_access: string | null;
  connection_status: string | null; feature_allowed: boolean;
}
interface Options { graphApi?: Omit<Partial<GraphApiOptions>, 'userId' | 'connectionId' | 'signal'> }
export interface AddressBookDeletionValue { provider: 'microsoft'; action: 'delete'; remoteAddressBookId: string }
interface Payload extends AddressBookDeletionValue {
  version: 1; connectionId: string; collectionId: string; localAddressBookId: string; confirmName: string;
}

/** A retry of an unknown DELETE is read-only until complete discovery proves absence. */
async function reconcileUnknownDeletion(userId: string, payload: Payload, operationId: string, accountId: string | null, options: Options): Promise<boolean> {
  if (!providerIntegrationsEnabled() || !accountId) return false;
  const syncStateId = await withTransaction(client => ensureSyncState(client, { userId, connectionId: payload.connectionId, feature: 'contacts', coverage: 'collection_discovery' }));
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner: `address-book-delete:${operationId}` }));
  if (!lease) return false;
  try {
    const folders = await discoverGraphContactFolders({ ...options.graphApi, userId, connectionId: payload.connectionId });
    if (folders.some(folder => folder.id === payload.remoteAddressBookId)) return false;
    return await withFencedSyncLease({ syncStateId, generation: lease.generation, run: async client => {
      await assertContactDiscoveryAuthorized(client, { userId, connectionId: payload.connectionId });
      const intent = await client.query(`SELECT a.id FROM email_accounts a
        JOIN account_provider_feature_settings setting ON setting.account_id=a.id AND setting.feature='contacts' AND setting.enabled
        WHERE a.id=$1 AND a.user_id=$2 AND a.provider_connection_id=$3 FOR SHARE OF a,setting`, [accountId, userId, payload.connectionId]);
      if (!intent.rows.length || !providerIntegrationsEnabled()) return false;
      // Unknown is terminal and owns no runnable lease. A concurrent journal owner
      // can only be changed if it still has this exact unknown deletion identity.
      const completed = await client.query(`UPDATE provider_operations SET status='committed',result=$4::jsonb,
          error_code=NULL,updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND status='outcome_unknown'
          AND resource_type='address_book_collection' AND operation='delete'
          AND payload->>'remoteAddressBookId'=$5 RETURNING id`,
      [operationId, userId, payload.connectionId, JSON.stringify({ provider: 'microsoft', action: 'delete', remoteAddressBookId: payload.remoteAddressBookId }), payload.remoteAddressBookId]);
      if (!completed.rows.length) return false;
      await retireAddressBookCollection(client, { userId, connectionId: payload.connectionId, remoteAddressBookId: payload.remoteAddressBookId }, operationId);
      return true;
    } });
  } finally {
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation }));
  }
}
async function readBook(userId: string, id: string): Promise<Book | undefined> {
  const rows = await query<Book>(`SELECT ab.id,ab.name,ab.source,ic.id collection_id,ic.remote_id,ic.connection_id,account.id account_id,
      ic.source_access,ic.user_access,pc.status connection_status,
      EXISTS(SELECT 1 FROM account_provider_feature_settings feature WHERE feature.account_id=account.id
        AND feature.feature='contacts' AND feature.enabled) feature_allowed
    FROM address_books ab LEFT JOIN integration_collections ic ON ic.local_address_book_id=ab.id AND ic.user_id=ab.user_id AND ic.kind='address_book'
    LEFT JOIN provider_connections pc ON pc.id=ic.connection_id AND pc.user_id=ab.user_id AND pc.provider=ab.source
    LEFT JOIN LATERAL (SELECT a.id FROM email_accounts a WHERE a.user_id=ab.user_id
      AND a.provider_connection_id=ic.connection_id AND (ic.account_id IS NULL OR a.id=ic.account_id)
      ORDER BY a.id LIMIT 1) account ON true
    WHERE ab.id=$1 AND ab.user_id=$2`, [id, userId]);
  return rows.rows[0];
}
async function localProtection(userId: string, book: Book): Promise<string | null> {
  if (!providerIntegrationsEnabled()) return 'Provider integrations are disabled by the administrator.';
  if (book.source === 'google') return 'Google Contacts is the primary contacts projection and cannot be deleted as an address book. No contacts will be deleted.';
  if (book.source !== 'microsoft') return 'Provider address book deletion is not supported for this source.';
  if (!book.connection_id || !book.collection_id || !book.remote_id || book.connection_status !== 'active') return 'The address book has no active provider connection.';
  if (book.remote_id === 'default_contacts' || book.remote_id === 'contacts') return 'The default Microsoft address book cannot be deleted.';
  if (!book.feature_allowed || !collectionIsWritable(book, 'contacts')) return 'This address book is read-only. Enable contacts write access before deleting it.';
  const grant = await withTransaction(client => readGrantForUser(client, { userId, connectionId: book.connection_id!, audience: MICROSOFT_GRANT_AUDIENCE }));
  if (!grant || grant.status !== 'active' || !graphGrantCoversScope(grant.currentScopes, REQUIRED_GRAPH_CONTACT_WRITE_SCOPE)) return 'Microsoft Contacts.ReadWrite permission is required.';
  return null;
}
export async function describeAddressBookDeletion(userId: string, addressBookId: string, options: Options = {}): Promise<{ supported: boolean; reason?: string }> {
  const book = await readBook(userId, addressBookId);
  if (!book) return { supported: false, reason: 'Address book not found.' };
  const reason = await localProtection(userId, book);
  if (reason) return { supported: false, reason };
  try {
    const protection = await inspectGraphAddressBookDeletion({ ...options.graphApi, userId, connectionId: book.connection_id! }, book.remote_id!);
    return protection.canDelete ? { supported: true } : { supported: false, reason: protection.reason };
  } catch (error) {
    if (error instanceof GraphApiError) return { supported: false, reason: `Microsoft could not verify deletion rights (${error.code}). Try again after the connection recovers.` };
    console.warn('Microsoft address book deletion capability could not be verified', { addressBookId, error });
    return { supported: false, reason: 'Microsoft could not verify deletion rights. Try again after the connection recovers.' };
  }
}

/** Exact key replay also works after successful projection cleanup. Unknown writes never dispatch again. */
export async function deleteProviderAddressBook(input: {
  userId: string; addressBookId: string; confirmName: string; idempotencyKey: string;
}, options: Options = {}): Promise<ProviderMutationResult<AddressBookDeletionValue>> {
  if (!input.idempotencyKey || input.idempotencyKey !== input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new AddressBookCollectionError('VALIDATION_ERROR', 400, 'A stable deletion idempotency key is required.');
  const replay = await query<{ payload: Payload; account_id: string | null }>(`SELECT payload,account_id FROM provider_operations WHERE user_id=$1
    AND resource_type='address_book_collection' AND operation='delete' AND idempotency_key=$2 AND resource_id=$3
    AND payload->>'localAddressBookId'=$3::text AND payload->>'confirmName'=$4`, [input.userId, input.idempotencyKey, input.addressBookId, input.confirmName]);
  const book = await readBook(input.userId, input.addressBookId);
  let payload: Payload;
  let accountId: string | null;
  if (replay.rows[0]) {
    const previous = replay.rows[0].payload;
    payload = { version: 1, provider: 'microsoft', action: 'delete', connectionId: previous.connectionId, collectionId: previous.collectionId, localAddressBookId: previous.localAddressBookId, remoteAddressBookId: previous.remoteAddressBookId, confirmName: previous.confirmName };
    accountId = replay.rows[0].account_id;
  } else {
    if (!book) throw new AddressBookCollectionError('RESOURCE_NOT_FOUND', 404, 'Address book not found.');
    if (book.name !== input.confirmName) throw new AddressBookCollectionError('VALIDATION_ERROR', 400, 'Confirm the exact address book name before deleting it from the provider.');
    const reason = await localProtection(input.userId, book);
    if (reason) throw new AddressBookCollectionError('COLLECTION_DELETE_UNSUPPORTED', 403, reason);
    payload = { version: 1, provider: 'microsoft', action: 'delete', connectionId: book.connection_id!, collectionId: book.collection_id!, localAddressBookId: book.id, remoteAddressBookId: book.remote_id!, confirmName: input.confirmName };
    accountId = book.account_id;
  }
  const result = await runProviderMutation<Payload, AddressBookDeletionValue>({
    userId: input.userId, accountId, connectionId: payload.connectionId, collectionId: book?.collection_id ?? null,
    resourceId: input.addressBookId, channel: 'web', operation: 'delete', idempotencyKey: input.idempotencyKey,
    payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), timeoutMs: 20_000,
  }, {
    resourceType: 'address_book_collection', idempotent: false,
    async perform(intent, context) {
      try {
        // Recheck permission on a known-safe journal retry as well as the initial request.
        const current = await readBook(input.userId, input.addressBookId);
        if (!current || current.connection_id !== intent.connectionId || current.remote_id !== intent.remoteAddressBookId) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        const reason = await localProtection(input.userId, current);
        if (reason) return { status: 'permanent', code: 'COLLECTION_DELETE_UNSUPPORTED' };
        await deleteGraphAddressBook({ ...options.graphApi, userId: input.userId, connectionId: intent.connectionId, signal: context.signal }, intent.remoteAddressBookId);
        context.signal.throwIfAborted();
        return { status: 'committed', value: { provider: 'microsoft', action: 'delete', remoteAddressBookId: intent.remoteAddressBookId } };
      } catch (error) {
        if (error instanceof GraphAddressBookProtectionError) return { status: 'permanent', code: 'COLLECTION_DELETE_UNSUPPORTED' };
        if (error instanceof GraphApiError) {
          if (error.status === 429) return { status: 'retryable', code: error.code, retryAfterSeconds: error.retryAfterSeconds };
          if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 499) return { status: 'permanent', code: error.code };
        }
        return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
      }
    },
  });
  if (result.status === 'outcome_unknown' && result.replayed && result.operationId) {
    try {
      if (await reconcileUnknownDeletion(input.userId, payload, result.operationId, accountId, options)) {
        return { ...result, status: 'confirmed', code: undefined, value: { provider: 'microsoft', action: 'delete', remoteAddressBookId: payload.remoteAddressBookId } };
      }
    } catch (error) {
      // The provider may still hold the collection. A failed read is never proof
      // of deletion and does not authorize repeating the mutation.
      console.warn('Address book deletion remains unconfirmed after reconciliation', { operationId: result.operationId, error });
    }
  }
  if (result.status === 'confirmed' && result.operationId) {
    try {
      await withTransaction(client => retireAddressBookCollection(client, { userId: input.userId, connectionId: payload.connectionId, remoteAddressBookId: payload.remoteAddressBookId }, result.operationId!));
    } catch (error) {
      console.error('Confirmed address book deletion awaits local projection cleanup', { operationId: result.operationId, error });
      return { ...result, status: 'pending', code: 'PROJECTION_PENDING' };
    }
  }
  return result;
}
