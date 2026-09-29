import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { evaluateProviderFeatureAuthorization } from './providerFeatureAuthorization.js';
import { GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE, ProviderAuthError } from './providerAuthService.js';
import { findCommittedCalendarDeletion, isCalendarCollectionDeleted, lockCalendarCollection, recordCalendarDeletionFence } from './calendarCollectionFence.js';
import { acquireSyncLease, ensureSyncState, failSyncRun, fenceSyncLease, finishSyncRun, releaseSyncLease, SyncLeaseLostError } from './syncCoordinator.js';

/** Remove a projection only after its caller has recorded a durable deletion fence. */
export async function retireCalendarProjection(client: PoolClient, input: {
  userId: string; connectionId: string; remoteCalendarId: string;
}): Promise<void> {
  await lockCalendarCollection(client, input);
  const rows = await client.query<{ id: string; local_calendar_id: string | null }>(`
    SELECT ic.id, ic.local_calendar_id FROM integration_collections ic
    WHERE ic.user_id=$1 AND ic.connection_id=$2 AND ic.kind='calendar' AND ic.remote_id=$3
      AND EXISTS (SELECT 1 FROM calendar_collection_tombstones t
        WHERE t.user_id=ic.user_id AND t.connection_id=ic.connection_id AND t.remote_calendar_id=ic.remote_id)
    FOR UPDATE`, [input.userId, input.connectionId, input.remoteCalendarId]);
  for (const row of rows.rows) {
    await client.query(`UPDATE sync_states SET running_generation=COALESCE(running_generation,0)+1,
      lease_expires_at=NULL,running_owner=NULL,last_error_code='RESOURCE_NOT_FOUND',updated_at=NOW()
      WHERE collection_id=$1 AND user_id=$2`, [row.id, input.userId]);
    await client.query(`UPDATE provider_push_subscriptions SET status='removed',updated_at=NOW()
      WHERE collection_id=$1 AND user_id=$2`, [row.id, input.userId]);
    await client.query(`DELETE FROM provider_sync_hints WHERE collection_id=$1 AND user_id=$2`, [row.id, input.userId]);
    await client.query(`DELETE FROM remote_object_links WHERE collection_id=$1 AND user_id=$2`, [row.id, input.userId]);
    await client.query(`UPDATE integration_collections SET enabled=false, local_calendar_id=NULL, updated_at=NOW() WHERE id=$1 AND user_id=$2`, [row.id, input.userId]);
    // Events, occurrences, shares and DAV sync state cascade from this exact owned projection.
    if (row.local_calendar_id) await client.query(`DELETE FROM calendars c WHERE c.id=$1 AND c.user_id=$2 AND c.owner_user_id=$2
      AND c.source=(SELECT provider FROM provider_connections WHERE id=$3 AND user_id=$2)`, [row.local_calendar_id, input.userId, input.connectionId]);
  }
}

/**
 * The loader MUST return a validated, complete, unfiltered provider snapshot or throw.
 * A lease is acquired before any network read. A superseded/expired discovery cannot
 * retire collections or resurrect an old snapshot. HTTP failures never enter apply.
 */
export async function discoverNativeCalendars<T extends { id: string }>(input: {
  userId: string; connectionId: string;
  load: (heartbeat: () => Promise<void>) => Promise<T[]>;
  ensure: (client: PoolClient, entry: T) => Promise<void>;
}): Promise<T[]> {
  const syncStateId = await withTransaction(async client => {
    const owner = await client.query('SELECT id FROM provider_connections WHERE id=$1 AND user_id=$2 AND status=\'active\'', [input.connectionId, input.userId]);
    if (!owner.rows.length) throw new Error('Active calendar provider connection is not owned by this user');
    return ensureSyncState(client, { userId: input.userId, connectionId: input.connectionId, feature: 'calendars', coverage: 'collection_discovery' });
  });
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner: `calendar-discovery:${input.connectionId}` }));
  if (!lease) throw new SyncLeaseLostError('Another calendar discovery is running');
  const fence = { syncStateId, generation: lease.generation };
  try {
    const entries = await input.load(() => withTransaction(client => fenceSyncLease(client, fence)));
    await withTransaction(async client => {
      await fenceSyncLease(client, fence);
      await client.query(`SELECT fs.account_id FROM email_accounts ea
        JOIN account_provider_feature_settings fs ON fs.account_id=ea.id AND fs.feature='calendars'
        WHERE ea.user_id=$1 AND ea.provider_connection_id=$2 FOR SHARE OF ea,fs`, [input.userId,input.connectionId]);
      const authorized = await client.query<{ provider: 'google' | 'microsoft'; current_scopes: string[] }>(`SELECT pc.provider,og.current_scopes
        FROM provider_connections pc JOIN oauth_grants og ON og.connection_id=pc.id
        WHERE pc.id=$1 AND pc.user_id=$2 AND pc.status='active' AND og.status='active'
          AND og.audience=CASE WHEN pc.provider='google' THEN $3 ELSE $4 END
          AND (NOT EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.user_id=pc.user_id AND ea.provider_connection_id=pc.id)
            OR EXISTS (SELECT 1 FROM email_accounts ea JOIN account_provider_feature_settings fs ON fs.account_id=ea.id
              WHERE ea.user_id=pc.user_id AND ea.provider_connection_id=pc.id AND fs.feature='calendars' AND fs.enabled))
        FOR SHARE OF pc,og`, [input.connectionId, input.userId, GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE]);
      const grant = authorized.rows[0];
      const authorization = grant && evaluateProviderFeatureAuthorization(grant.provider, 'calendar', grant.current_scopes);
      if (!authorization?.canDiscover || !authorization.canRead) throw new ProviderAuthError('INSUFFICIENT_SCOPES', 'Calendar discovery authorization changed during the provider read');
      const existing = await client.query<{ remote_id: string }>(`SELECT remote_id FROM integration_collections
        WHERE user_id=$1 AND connection_id=$2 AND kind='calendar'
          AND created_at <= (SELECT running_started_at FROM sync_states WHERE id=$3)`, [input.userId, input.connectionId, syncStateId]);
      const present = new Map(entries.map(entry => [entry.id, entry]));
      // Match every other calendar writer's advisory lock ordering.
      for (const remoteCalendarId of [...new Set([...present.keys(), ...existing.rows.map(row => row.remote_id)])].sort()) {
        const identity = { userId: input.userId, connectionId: input.connectionId, remoteCalendarId };
        await lockCalendarCollection(client, identity);
        const entry = present.get(remoteCalendarId);
        if (await isCalendarCollectionDeleted(client, identity)) {
          const operationId = await findCommittedCalendarDeletion(client, identity);
          if (operationId) await recordCalendarDeletionFence(client, { ...identity, operationId });
          await retireCalendarProjection(client, identity);
        } else if (entry) await input.ensure(client, entry);
        else {
          await client.query(`INSERT INTO calendar_collection_tombstones
            (user_id,connection_id,remote_calendar_id,retirement_reason,discovery_generation)
            VALUES ($1,$2,$3,'complete_discovery',$4) ON CONFLICT DO NOTHING`, [input.userId, input.connectionId, remoteCalendarId, lease.generation]);
          await retireCalendarProjection(client, identity);
        }
      }
      if (!await finishSyncRun(client, { ...fence, lastErrorCode: null })) throw new SyncLeaseLostError();
      await releaseSyncLease(client, fence);
    });
    return entries;
  } catch (error) {
    await withTransaction(client => failSyncRun(client, { ...fence, errorCode: error instanceof SyncLeaseLostError ? error.code : 'COLLECTION_DISCOVERY_FAILED' }));
    throw error;
  }
}
