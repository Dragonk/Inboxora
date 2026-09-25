import { Router } from 'express';
import type { Request, Response } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { describeAccountProviderFeatures } from '../services/accountProviderFeatures.js';
import { providerIntegrationsEnabled } from '../services/providerSwitches.js';
import { runCalendarCollectionMutation, CalendarCollectionMutationValidationError, type CalendarCollectionMutationInput } from '../services/calendarCollectionMutation.js';
import { projectCalendarCollection } from '../services/calendarCollectionProjection.js';
import { isUuid } from '../utils/uuid.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);
const read = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
function accountId(req: Request) { const value = req.params.accountId; return typeof value === 'string' && isUuid(value) ? value : null; }

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
  const row=await query<{ id:string;local_calendar_id:string|null;remote_id:string;source:string;provider_user_id:string|null }>(`SELECT ic.id,ic.local_calendar_id,ic.remote_id,c.source,pc.provider_user_id FROM integration_collections ic JOIN calendars c ON c.id=ic.local_calendar_id AND c.user_id=ic.user_id JOIN provider_connections pc ON pc.id=ic.connection_id AND pc.user_id=ic.user_id WHERE ic.id=$1 AND ic.user_id=$2 AND ic.connection_id=$3 AND ic.kind='calendar'`,[collectionId,req.session.userId,resolved.connectionId]);
  const item=row.rows[0];
  if(!item||!item.local_calendar_id||item.source!==resolved.provider) return res.status(404).json({ code:'RESOURCE_NOT_FOUND',error:'Provider calendar collection not found' });
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
