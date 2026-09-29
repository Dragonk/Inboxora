import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { fenceSyncLease } from './syncCoordinator.js';
import { evaluateProviderFeatureAuthorization } from './providerFeatureAuthorization.js';
import { GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE, ProviderAuthError } from './providerAuthService.js';

export interface AddressBookCollectionIdentity {
  userId: string;
  connectionId: string;
  remoteAddressBookId: string;
}

export class AddressBookCollectionDeletedError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';
  constructor() { super('Address book collection has a confirmed deletion fence'); }
}

/** Hold authorization rows through retirement, so revoked consent cannot turn an old read into cleanup. */
export async function assertContactDiscoveryAuthorized(client: PoolClient, input: { userId: string; connectionId: string }): Promise<void> {
  await client.query(`SELECT fs.account_id FROM email_accounts ea
    JOIN account_provider_feature_settings fs ON fs.account_id=ea.id AND fs.feature='contacts'
    WHERE ea.user_id=$1 AND ea.provider_connection_id=$2 FOR SHARE OF ea,fs`, [input.userId, input.connectionId]);
  const result = await client.query<{ provider: 'google' | 'microsoft'; current_scopes: string[] }>(`SELECT pc.provider,og.current_scopes
    FROM provider_connections pc JOIN oauth_grants og ON og.connection_id=pc.id
    WHERE pc.id=$1 AND pc.user_id=$2 AND pc.status='active' AND og.status='active'
      AND pc.provider IN ('google','microsoft') AND og.audience=CASE WHEN pc.provider='google' THEN $3 ELSE $4 END
      AND (NOT EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.user_id=pc.user_id AND ea.provider_connection_id=pc.id)
        OR EXISTS (SELECT 1 FROM email_accounts ea JOIN account_provider_feature_settings fs ON fs.account_id=ea.id
          WHERE ea.user_id=pc.user_id AND ea.provider_connection_id=pc.id AND fs.feature='contacts' AND fs.enabled))
    FOR SHARE OF pc,og`, [input.connectionId, input.userId, GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE]);
  const grant = result.rows[0];
  const authorization = grant && evaluateProviderFeatureAuthorization(grant.provider, 'contacts', grant.current_scopes);
  if (!authorization?.canDiscover || !authorization.canRead) throw new ProviderAuthError('INSUFFICIENT_SCOPES', 'Contacts discovery authorization changed during the provider read');
}

/** Transaction lock order: collection identity, then its sync lease. */
export async function lockAddressBookCollection(client: PoolClient, identity: AddressBookCollectionIdentity): Promise<void> {
  const owner = await client.query('SELECT id FROM provider_connections WHERE id=$1 AND user_id=$2', [identity.connectionId, identity.userId]);
  if (!owner.rows.length || !identity.remoteAddressBookId.trim()) throw new Error('Address book connection ownership is invalid');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['address_book_collection', identity.userId, identity.connectionId, identity.remoteAddressBookId])]);
}

export async function assertAddressBookCollectionPresent(client: PoolClient, identity: AddressBookCollectionIdentity): Promise<void> {
  await lockAddressBookCollection(client, identity);
  const deleted = await client.query('SELECT 1 FROM address_book_collection_tombstones WHERE user_id=$1 AND connection_id=$2 AND remote_address_book_id=$3', [identity.userId, identity.connectionId, identity.remoteAddressBookId]);
  if (deleted.rows.length) throw new AddressBookCollectionDeletedError();
  // The durable upstream receipt closes the gap before local cleanup can commit.
  const committed = await client.query(`SELECT 1 FROM provider_operations op
    JOIN provider_connections pc ON pc.id=op.connection_id AND pc.user_id=op.user_id
    WHERE op.user_id=$1 AND op.connection_id=$2 AND op.resource_type='address_book_collection'
      AND op.operation='delete' AND op.status='committed'
      AND op.payload->'version'='1'::jsonb AND op.payload->>'action'='delete'
      AND op.payload->>'connectionId'=$2::text
      AND jsonb_typeof(op.payload->'remoteAddressBookId')='string'
      AND jsonb_typeof(op.result->'remoteAddressBookId')='string' AND op.payload->>'remoteAddressBookId'=$3
      AND op.result->>'remoteAddressBookId'=$3 AND op.payload->>'provider'=pc.provider
      AND op.result->>'provider'=pc.provider AND op.result->>'action'='delete'`, [identity.userId, identity.connectionId, identity.remoteAddressBookId]);
  if (committed.rows.length) throw new AddressBookCollectionDeletedError();
}

export async function withAddressBookCollectionSyncFence<T>(identity: AddressBookCollectionIdentity, input: {
  syncStateId: string; generation: number; run: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  return withTransaction(async client => {
    await assertAddressBookCollectionPresent(client, identity);
    await fenceSyncLease(client, input);
    return input.run(client);
  });
}

/** Caller proves complete discovery under its source lease, or supplies committed deletion evidence. */
export async function retireAddressBookCollection(client: PoolClient, identity: AddressBookCollectionIdentity, operationId: string | null = null, discoveryGeneration: number | null = null): Promise<void> {
  await lockAddressBookCollection(client, identity);
  if (operationId) {
    const evidence = await client.query(`SELECT op.id FROM provider_operations op
      JOIN provider_connections pc ON pc.id=op.connection_id AND pc.user_id=op.user_id
      WHERE op.id=$1 AND op.user_id=$2 AND op.connection_id=$3
        AND op.resource_type='address_book_collection' AND op.operation='delete' AND op.status='committed'
        AND op.payload->'version'='1'::jsonb AND op.payload->>'action'='delete'
        AND jsonb_typeof(op.payload->'remoteAddressBookId')='string'
        AND jsonb_typeof(op.result->'remoteAddressBookId')='string'
        AND op.payload->>'remoteAddressBookId'=$4 AND op.result->>'remoteAddressBookId'=$4
        AND op.payload->>'connectionId'=$3::text AND op.payload->>'provider'=pc.provider
        AND op.result->>'provider'=pc.provider AND op.result->>'action'='delete'
      FOR SHARE OF op`, [operationId, identity.userId, identity.connectionId, identity.remoteAddressBookId]);
    if (!evidence.rows.length) throw new Error('Address book retirement requires matching committed deletion evidence');
  }
  await client.query(`INSERT INTO address_book_collection_tombstones(user_id,connection_id,remote_address_book_id,operation_id,retirement_reason,discovery_generation)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,connection_id,remote_address_book_id) DO UPDATE
      SET operation_id=EXCLUDED.operation_id,retirement_reason=EXCLUDED.retirement_reason,discovery_generation=NULL
      WHERE EXCLUDED.retirement_reason='confirmed_delete' AND EXCLUDED.operation_id IS NOT NULL`,
    [identity.userId, identity.connectionId, identity.remoteAddressBookId, operationId,
      !operationId && discoveryGeneration !== null ? 'complete_discovery' : 'confirmed_delete', discoveryGeneration]);
  const collections = await client.query<{ id: string; local_address_book_id: string | null }>(`SELECT ic.id,book.id local_address_book_id FROM integration_collections ic
    JOIN provider_connections pc ON pc.id=ic.connection_id AND pc.user_id=ic.user_id
    LEFT JOIN address_books book ON book.id=ic.local_address_book_id AND book.user_id=ic.user_id AND book.source=pc.provider
    WHERE ic.user_id=$1 AND ic.connection_id=$2 AND ic.remote_id=$3 AND ic.kind='address_book' FOR UPDATE OF ic`, [identity.userId, identity.connectionId, identity.remoteAddressBookId]);
  for (const collection of collections.rows) {
    if (collection.local_address_book_id) {
      // A shared person may still belong to another provider collection. Preserve that
      // contact and its other memberships before the book's ON DELETE CASCADE runs.
      await client.query(`UPDATE contacts c SET address_book_id=(
          SELECT other.local_address_book_id FROM remote_object_links link
          JOIN integration_collections other ON other.id=link.collection_id AND other.user_id=c.user_id
          JOIN address_books book ON book.id=other.local_address_book_id AND book.user_id=c.user_id
          WHERE link.local_id=c.id AND link.user_id=c.user_id AND link.object_type='contact' AND link.status='active'
            AND other.id<>$1 AND other.local_address_book_id<>$2 ORDER BY other.id LIMIT 1)
        WHERE c.user_id=$3 AND c.address_book_id=$2 AND EXISTS(
          SELECT 1 FROM remote_object_links link JOIN integration_collections other ON other.id=link.collection_id AND other.user_id=c.user_id
          JOIN address_books book ON book.id=other.local_address_book_id AND book.user_id=c.user_id
          WHERE link.local_id=c.id AND link.user_id=c.user_id AND link.object_type='contact' AND link.status='active'
            AND other.id<>$1 AND other.local_address_book_id<>$2)`, [collection.id, collection.local_address_book_id, identity.userId]);
      await client.query('DELETE FROM address_books WHERE id=$1 AND user_id=$2', [collection.local_address_book_id, identity.userId]);
    }
    // Cascades remove links, collection memberships, leases and push subscriptions.
    await client.query('DELETE FROM integration_collections WHERE id=$1 AND user_id=$2', [collection.id, identity.userId]);
  }
}

/** Only invoke for a validated, complete provider listing while holding its discovery lease. */
export async function reconcileAddressBookCollections(client: PoolClient, input: {
  userId: string; connectionId: string; seenRemoteIds: readonly string[]; syncStateId: string; generation: number;
}): Promise<void> {
  await assertContactDiscoveryAuthorized(client, input);
  for (const remoteAddressBookId of [...new Set(input.seenRemoteIds)].sort()) {
    await lockAddressBookCollection(client, { ...input, remoteAddressBookId });
    await client.query(`DELETE FROM address_book_collection_tombstones
      WHERE user_id=$1 AND connection_id=$2 AND remote_address_book_id=$3
        AND retirement_reason='complete_discovery' AND discovery_generation < $4`,
      [input.userId,input.connectionId,remoteAddressBookId,input.generation]);
  }
  const missing = await client.query<{ remote_id: string }>(`SELECT remote_id FROM integration_collections
    WHERE user_id=$1 AND connection_id=$2 AND kind='address_book' AND NOT(remote_id=ANY($3::text[]))
      AND remote_id NOT IN ('default_contacts','contacts','people/me')
      AND created_at <= (SELECT running_started_at FROM sync_states WHERE id=$4 AND user_id=$1 AND connection_id=$2)
    ORDER BY remote_id`, [input.userId, input.connectionId, input.seenRemoteIds, input.syncStateId]);
  for (const row of missing.rows) await retireAddressBookCollection(client, { ...input, remoteAddressBookId: row.remote_id }, null, input.generation);
}
