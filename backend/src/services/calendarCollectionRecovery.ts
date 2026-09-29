import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { acquireSyncLease, ensureSyncState, fenceSyncLease, releaseSyncLease } from './syncCoordinator.js';
import { lockCalendarCollection, recordCalendarDeletionFence } from './calendarCollectionFence.js';
import { retireCalendarProjection } from './calendarCollectionDiscovery.js';
import { fetchCalendarList } from './providers/google/googleCalendar.js';
import { fetchGraphCalendarsPage } from './providers/microsoft/graphCalendar.js';
import { googleConfigFromEnv, microsoftConfigFromEnv, GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE } from './providerAuthService.js';
import { evaluateProviderFeatureAuthorization } from './providerFeatureAuthorization.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import type { CalendarCollectionMutationOptions, CalendarCollectionMutationValue, CalendarCollectionProvider } from './calendarCollectionMutation.js';

export interface CalendarDeletionRecoveryInput {
  operationId: string; userId: string; accountId: string; connectionId: string; provider: CalendarCollectionProvider;
}

/** An unknown DELETE may be confirmed by a complete list read; it is never dispatched again. */
export async function recoverUnknownCalendarDeletion(input: CalendarDeletionRecoveryInput, options: CalendarCollectionMutationOptions & { maxRecoveryPages?: number } = {}): Promise<CalendarCollectionMutationValue | null> {
  if (!providerIntegrationsEnabled()) return null;
  const stored = await query<{ remote_id: string }>(`SELECT payload->>'remoteCalendarId' AS remote_id FROM provider_operations
    WHERE id=$1 AND user_id=$2 AND account_id=$3 AND connection_id=$4 AND status='outcome_unknown'
      AND resource_type='calendar_collection' AND operation='delete'
      AND payload->'version'='1'::jsonb AND payload->>'provider'=$5 AND payload->>'action'='delete'
      AND payload->>'connectionId'=$4::text AND payload->>'accountId'=$3::text
      AND jsonb_typeof(payload->'remoteCalendarId')='string'`, [input.operationId,input.userId,input.accountId,input.connectionId,input.provider]);
  const remoteId = stored.rows[0]?.remote_id;
  if (!remoteId?.trim()) return null;

  const authorized = async (client: PoolClient): Promise<boolean> => {
    if (!providerIntegrationsEnabled()) return false;
    const owner = await client.query<{current_scopes:string[]}>(`SELECT og.current_scopes FROM provider_connections pc
      JOIN email_accounts ea ON ea.id=$3 AND ea.user_id=pc.user_id
        AND (ea.provider_connection_id=pc.id OR lower(ea.email_address)=lower(pc.provider_user_id))
      JOIN oauth_grants og ON og.connection_id=pc.id AND og.status='active'
        AND og.audience=$5
      JOIN account_provider_feature_settings fs ON fs.account_id=ea.id AND fs.feature='calendars' AND fs.enabled
      WHERE pc.id=$1 AND pc.user_id=$2 AND pc.provider=$4 AND pc.status='active'
      FOR SHARE OF pc,ea,fs,og`, [input.connectionId,input.userId,input.accountId,input.provider,input.provider==='google'?GOOGLE_GRANT_AUDIENCE:MICROSOFT_GRANT_AUDIENCE]);
    if (!owner.rows.length) return false;
    return evaluateProviderFeatureAuthorization(input.provider,'calendar',owner.rows[0]!.current_scopes).canDiscover;
  };
  const syncStateId = await withTransaction(async client => await authorized(client)
    ? ensureSyncState(client,{userId:input.userId,connectionId:input.connectionId,feature:'calendars',coverage:'collection_discovery'}) : null);
  if (!syncStateId) return null;
  const lease = await withTransaction(client=>acquireSyncLease(client,{syncStateId,owner:`calendar-delete-recovery:${input.operationId}`}));
  if (!lease) return null;
  const fence={syncStateId,generation:lease.generation};
  try {
    const maxPages=options.maxRecoveryPages??1000;
    let next: string|null=null;
    let present=false, complete=false;
    for (let page=0;page<maxPages;page++) {
      await withTransaction(client=>fenceSyncLease(client,fence));
      if (input.provider==='google') {
        const result=await fetchCalendarList({...options.googleApi,userId:input.userId,connectionId:input.connectionId,config:options.googleApi?.config??googleConfigFromEnv()},{pageToken:next});
        present ||= result.calendars.some(calendar=>calendar.id===remoteId);
        next=result.nextPageToken;
      } else {
        const result=await fetchGraphCalendarsPage({...options.graphApi,userId:input.userId,connectionId:input.connectionId,config:options.graphApi?.config??microsoftConfigFromEnv()},{link:next});
        present ||= result.calendars.some(calendar=>calendar.id===remoteId);
        next=result.nextLink;
      }
      if (!next) {complete=true;break;}
    }
    if (!complete || present) return null;
    return await withTransaction(async client=>{
      await fenceSyncLease(client,fence);
      if (!await authorized(client)) return null;
      const identity={userId:input.userId,connectionId:input.connectionId,remoteCalendarId:remoteId};
      await lockCalendarCollection(client,identity);
      const value:CalendarCollectionMutationValue={provider:input.provider,action:'delete',remoteCalendarId:remoteId,name:null};
      const changed=await client.query(`UPDATE provider_operations SET status='committed',result=$6::jsonb,error_code=NULL,updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND account_id=$3 AND connection_id=$4 AND status='outcome_unknown'
          AND resource_type='calendar_collection' AND operation='delete' AND payload->>'remoteCalendarId'=$5 RETURNING id`,
      [input.operationId,input.userId,input.accountId,input.connectionId,remoteId,JSON.stringify(value)]);
      if (!changed.rows.length) return null;
      await recordCalendarDeletionFence(client,{...identity,operationId:input.operationId});
      await retireCalendarProjection(client,identity);
      return value;
    });
  } finally {
    await withTransaction(client=>releaseSyncLease(client,fence));
  }
}
