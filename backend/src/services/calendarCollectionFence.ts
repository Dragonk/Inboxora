import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { fenceSyncLease } from './syncCoordinator.js';

export interface CalendarCollectionIdentity {
  userId: string;
  connectionId: string;
  remoteCalendarId: string;
}

export class CalendarCollectionDeletedError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';
  constructor() { super('Calendar collection has a confirmed deletion fence'); this.name = 'CalendarCollectionDeletedError'; }
}

/** Caller MUST hold a transaction; take this lock before sync-state/lease row locks. */
export async function lockCalendarCollection(client: PoolClient, identity: CalendarCollectionIdentity): Promise<void> {
  if (!identity.remoteCalendarId.trim()) throw new Error('Calendar collection identity is required');
  const owner = await client.query('SELECT id FROM provider_connections WHERE id = $1 AND user_id = $2', [identity.connectionId, identity.userId]);
  if (!owner.rows.length) throw new Error('Calendar provider connection is not owned by this user');
  // A collision can only serialize unrelated work. It cannot confuse identity:
  // every actual row lookup still uses the complete user/connection/remote key.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['calendar_collection', identity.userId, identity.connectionId, identity.remoteCalendarId])]);
}

/** Read under lockCalendarCollection when this check guards a subsequent write. */
export async function isCalendarCollectionDeleted(client: PoolClient, identity: CalendarCollectionIdentity): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM calendar_collection_tombstones WHERE user_id = $1 AND connection_id = $2 AND remote_calendar_id = $3', [identity.userId, identity.connectionId, identity.remoteCalendarId]);
  return result.rows.length > 0;
}

export async function assertCalendarCollectionPresent(client: PoolClient, identity: CalendarCollectionIdentity): Promise<void> {
  await lockCalendarCollection(client, identity);
  if (await isCalendarCollectionDeleted(client, identity)) throw new CalendarCollectionDeletedError();
}

/** Calendar advisory lock precedes the lease row lock; never invert this in cleanup. */
export async function withCalendarCollectionSyncFence<T>(identity: CalendarCollectionIdentity, input: {
  syncStateId: string; generation: number; run: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  return withTransaction(async client => {
    await assertCalendarCollectionPresent(client, identity);
    await fenceSyncLease(client, input);
    return input.run(client);
  });
}

/** Only a committed, matching remote delete may fence discovery. No projection is deleted here. */
export async function recordCalendarDeletionFence(client: PoolClient, input: CalendarCollectionIdentity & { operationId: string }): Promise<void> {
  await lockCalendarCollection(client, input);
  // runProviderMutation stores adapter outcome.value directly in result (not {value: ...}).
  // Keep row ownership/identity predicates in SQL; a guessed 404 or pending intent is not evidence.
  const operation = await client.query(`
    SELECT op.id FROM provider_operations op
    JOIN provider_connections pc ON pc.id = op.connection_id AND pc.user_id = op.user_id
    WHERE op.id = $1 AND op.user_id = $2 AND op.connection_id = $3
      AND op.resource_type = 'calendar_collection' AND op.operation = 'delete' AND op.status = 'committed'
      AND jsonb_typeof(op.payload) = 'object' AND jsonb_typeof(op.result) = 'object'
      AND op.payload->'version' = '1'::jsonb
      AND op.payload->>'action' = 'delete' AND op.result->>'action' = 'delete'
      AND op.payload->>'connectionId' = $3::text
      AND op.payload->>'accountId' = op.account_id::text
      AND jsonb_typeof(op.payload->'remoteCalendarId') = 'string'
      AND jsonb_typeof(op.result->'remoteCalendarId') = 'string'
      AND op.payload->>'remoteCalendarId' = $4 AND op.result->>'remoteCalendarId' = $4
      AND op.payload->>'provider' = pc.provider AND op.result->>'provider' = pc.provider
    FOR SHARE OF op`, [input.operationId, input.userId, input.connectionId, input.remoteCalendarId]);
  if (!operation.rows.length) throw new Error('Calendar deletion fence requires a matching committed provider operation');
  await client.query(`INSERT INTO calendar_collection_tombstones (user_id, connection_id, remote_calendar_id, operation_id)
    VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, connection_id, remote_calendar_id) DO NOTHING`,
  [input.userId, input.connectionId, input.remoteCalendarId, input.operationId]);
}
