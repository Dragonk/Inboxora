import { recoverUnknownCalendarDeletion } from '../services/calendarCollectionRecovery.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { describeAccountProviderFeatures } from '../services/accountProviderFeatures.js';
import { providerIntegrationsEnabled } from '../services/providerSwitches.js';
import { runCalendarCollectionMutation, CalendarCollectionMutationValidationError, type CalendarCollectionMutationInput } from '../services/calendarCollectionMutation.js';
import { projectCalendarCollection } from '../services/calendarCollectionProjection.js';
import { inspectGoogleCalendarManagement } from '../services/providers/google/googleCalendarManagement.js';
import { inspectGraphCalendarManagement } from '../services/providers/microsoft/graphCalendarManagement.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from '../services/providerAuthService.js';
import { isUuid } from '../utils/uuid.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);
const read = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
function accountId(req: Request) { const value = req.params.accountId; return typeof value === 'string' && isUuid(value) ? value : null; }

export async function describeCalendarCollectionDeletion(userId: string, row: {
  source?: unknown; account_id?: unknown; connection_id?: unknown; remote_id?: unknown; provider_user_id?: unknown;
}): Promise<{ supported: boolean; reason?: string }> {
  if (row.source === 'local') return { supported: true };
  const unavailable = (reason: string) => ({ supported: false, reason });
  if (row.source !== 'google' && row.source !== 'microsoft') return unavailable('This collection cannot be deleted at its provider here.');
  if (!providerIntegrationsEnabled()) return unavailable('Provider integrations are disabled.');
  if (typeof row.account_id !== 'string' || typeof row.connection_id !== 'string' || typeof row.remote_id !== 'string') return unavailable('The provider account could not be verified.');
  try {
    const features = await describeAccountProviderFeatures({ userId, accountId: row.account_id });
    if (features?.provider !== row.source || features.calendar?.connectionId !== row.connection_id) return unavailable('The provider account could not be verified.');
    if (!features.calendar.enabled) return unavailable('Calendar access is disabled for this account.');
    if (!features.calendar.calendarManagement?.authorized) return unavailable('Authorize calendar management for this account first.');
    const protection = row.source === 'google'
      ? await inspectGoogleCalendarManagement({ userId, connectionId: row.connection_id, config: googleConfigFromEnv() }, row.remote_id)
      : await inspectGraphCalendarManagement({ userId, connectionId: row.connection_id, config: microsoftConfigFromEnv() }, row.remote_id, typeof row.provider_user_id === 'string' ? row.provider_user_id : '');
    if (protection.canDelete) return { supported: true };
    if (protection.reason === 'primary_calendar' || protection.reason === 'default_calendar') return unavailable('The default calendar cannot be deleted.');
    if (protection.reason === 'not_owner') return unavailable('Only calendars owned by this provider account can be deleted.');
    if (protection.reason === 'not_editable') return unavailable('This calendar is read-only.');
    return unavailable('The provider could not verify calendar ownership and deletion rights.');
  } catch (error) {
    console.warn('Calendar deletion capability could not be verified', {errorType:error instanceof Error?error.name:'UnknownError'});
    // A failed capability read is never evidence of deletion or permission to delete.
    return unavailable('Deletion rights could not be verified. Refresh after the provider is available.');
  }
}

async function target(req: Request, res: Response) {
  const id = accountId(req); if (!id) { res.status(400).json({ code:'VALIDATION_ERROR', error:'Invalid account id' }); return null; }
  if (!providerIntegrationsEnabled()) { res.status(503).json({ code:'FEATURE_DISABLED', error:'Provider integrations are disabled' }); return null; }
  const features = await describeAccountProviderFeatures({ userId:req.session.userId!, accountId:id });
  const calendar = features?.calendar;
  if (!features || !calendar || (features.provider !== 'google' && features.provider !== 'microsoft')) { res.status(404).json({ code:'RESOURCE_NOT_FOUND', error:'Provider calendar account not found' }); return null; }
  if (!calendar.enabled) { res.status(403).json({ code:'FEATURE_DISABLED', error:'Calendars are disabled for this account' }); return null; }
  if (!calendar.calendarManagement?.authorized) { res.status(403).json({ code:'INSUFFICIENT_SCOPES', missingScopes:calendar.calendarManagement?.missingScopes ?? [], error:'Calendar management authorization is required' }); return null; }
  if (!calendar.connectionId) { res.status(409).json({ code:'CONNECTION_UNRESOLVED', error:'Calendar connection is unresolved' }); return null; }
  return { id, provider:features.provider, connectionId:calendar.connectionId } as const;
}
function response(res: Response, result: Awaited<ReturnType<typeof runCalendarCollectionMutation>>, projection?: Awaited<ReturnType<typeof projectCalendarCollection>>) {
  if (result.status === 'conflict') return res.status(409).json({ operationId:result.operationId,state:'conflict',replayed:result.replayed,code:result.code });
  if (result.status === 'confirmed') {
    if (!result.operationId || !result.value) return res.status(502).json({ operationId:result.operationId,state:'outcome_unknown',replayed:result.replayed,code:'MUTATION_OUTCOME_UNKNOWN' });
    if (!projection || projection.state !== 'projected') return res.status(202).json({ operationId:result.operationId,state:'pending',replayed:result.replayed,code:'PROJECTION_PENDING' });
    return res.status(200).json({ operationId:result.operationId,state:'confirmed',replayed:result.replayed,collectionId:projection.collectionId,localCalendarId:projection.localCalendarId });
  }
  const status = result.status === 'retryable' ? 503 : result.status === 'pending' ? 202 : result.status === 'permanent' ? 422 : 502;
  return res.status(status).json({ operationId:result.operationId,state:result.status,replayed:result.replayed,code:result.code,...(result.retryAfterSeconds !== undefined ? {retryAfterSeconds:result.retryAfterSeconds}: {}) });
}

router.post('/:accountId/provider-calendars', async (req,res) => {
  const resolved = await target(req,res); if (!resolved) return;
  const name=read(req.body?.name,255), idempotencyKey=read(req.body?.idempotencyKey,200);
  if (!name || !idempotencyKey) return res.status(400).json({ code:'VALIDATION_ERROR',error:'name and idempotencyKey are required' });
  try {
    const result=await runCalendarCollectionMutation({ userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,provider:resolved.provider,action:'create',name,idempotencyKey });
    const projection=result.status==='confirmed'&&result.operationId&&result.value ? await projectCalendarCollection({ operationId:result.operationId,userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,value:result.value }) : undefined;
    return response(res,result,projection);
  } catch (error) {
    if (error instanceof CalendarCollectionMutationValidationError) return res.status(400).json({ code:error.code,error:error.message });
    console.error('Provider calendar create failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ code:'INTERNAL_ERROR',error:'Could not start calendar lifecycle operation' });
  }
});
router.delete('/:accountId/provider-calendars/:collectionId', async (req,res) => {
  const resolved=await target(req,res); if(!resolved) return;
  const collectionId=typeof req.params.collectionId === 'string' ? req.params.collectionId : '', idempotencyKey=read(req.body?.idempotencyKey,200);
  if(!isUuid(collectionId)||!idempotencyKey) return res.status(400).json({ code:'VALIDATION_ERROR',error:'collectionId and idempotencyKey are required' });
  const row=await query<{ id:string;local_calendar_id:string|null;remote_id:string;source:string;name:string;provider_user_id:string|null }>(`SELECT ic.id,ic.local_calendar_id,ic.remote_id,c.source,c.name,pc.provider_user_id FROM integration_collections ic JOIN calendars c ON c.id=ic.local_calendar_id AND c.user_id=ic.user_id JOIN provider_connections pc ON pc.id=ic.connection_id AND pc.user_id=ic.user_id WHERE ic.id=$1 AND ic.user_id=$2 AND ic.connection_id=$3 AND ic.kind='calendar' AND (ic.account_id IS NULL OR ic.account_id=$4)`,[collectionId,req.session.userId,resolved.connectionId,resolved.id]);
  const item=row.rows[0];
  if (!item || !item.local_calendar_id || item.source !== resolved.provider) {
    // A successful deletion removes the local calendar, but its durable intent remains.
    // Replay only the same tenant/account/connection/collection intent; never dispatch a
    // second DELETE merely because the projection no longer exists.
    const replay = await query<{ id: string; status: string; result: unknown }>(
      `SELECT id,status,result FROM provider_operations
        WHERE user_id=$1 AND account_id=$2 AND connection_id=$3 AND idempotency_key=$4
          AND resource_type='calendar_collection' AND operation='delete'
          AND payload->>'collectionId'=$5 AND payload->>'provider'=$6`,
      [req.session.userId, resolved.id, resolved.connectionId, idempotencyKey, collectionId, resolved.provider]);
    const operation = replay.rows[0];
    if (!operation) return res.status(404).json({ code:'RESOURCE_NOT_FOUND',error:'Provider calendar collection not found' });
    const value = operation.result;
    if (operation.status === 'committed' && value && typeof value === 'object' && 'provider' in value && value.provider === resolved.provider && 'action' in value && value.action === 'delete' && 'remoteCalendarId' in value && typeof value.remoteCalendarId === 'string') {
      const confirmed = { provider: resolved.provider, action: 'delete' as const, remoteCalendarId: value.remoteCalendarId, name: null };
      const projection = await projectCalendarCollection({ operationId:operation.id,userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,value:confirmed });
      return response(res,{status:'confirmed',operationId:operation.id,replayed:true,value:confirmed},projection);
    }
    if (operation.status === 'outcome_unknown') {
      try {
        const recovered = await recoverUnknownCalendarDeletion({operationId:operation.id,userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,provider:resolved.provider});
        if (recovered) {
          const projection = await projectCalendarCollection({operationId:operation.id,userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,value:recovered});
          return response(res,{status:'confirmed',operationId:operation.id,replayed:true,value:recovered},projection);
        }
      } catch (error) {
        console.warn('Calendar deletion status remains unknown', error instanceof Error ? error.message : error);
      }
    }
    return res.status(502).json({operationId:operation.id,state:'outcome_unknown',replayed:true,code:'MUTATION_OUTCOME_UNKNOWN'});
  }
  const confirmName = read(req.body?.confirmName,255);
  if (!confirmName || confirmName !== item.name) return res.status(400).json({code:'VALIDATION_ERROR',error:'confirmName must match the calendar name'});
  if(resolved.provider==='microsoft' && !item.provider_user_id) return res.status(409).json({ code:'OWNER_UNVERIFIED',error:'Verified provider mailbox identity is unavailable' });
  const verifiedMailboxIdentity = item.provider_user_id;
  try {
    const input: CalendarCollectionMutationInput=resolved.provider==='microsoft'
      ? { userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,provider:'microsoft',action:'delete',collectionId:item.id,localCalendarId:item.local_calendar_id,remoteCalendarId:item.remote_id,verifiedMailboxIdentity:verifiedMailboxIdentity!,idempotencyKey }
      : { userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,provider:'google',action:'delete',collectionId:item.id,localCalendarId:item.local_calendar_id,remoteCalendarId:item.remote_id,idempotencyKey };
    const result=await runCalendarCollectionMutation(input);
    const projection=result.status==='confirmed'&&result.operationId&&result.value ? await projectCalendarCollection({operationId:result.operationId,userId:req.session.userId!,accountId:resolved.id,connectionId:resolved.connectionId,value:result.value}):undefined;
    return response(res,result,projection);
  } catch (error) {
    if (error instanceof CalendarCollectionMutationValidationError) return res.status(400).json({code:error.code,error:error.message});
    console.error('Provider calendar delete failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({code:'INTERNAL_ERROR',error:'Could not start calendar lifecycle operation'});
  }
});
export default router;
