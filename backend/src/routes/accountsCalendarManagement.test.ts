import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express'; import type { Server } from 'node:http'; import { listeningPort } from '../test/net.js';
const m=vi.hoisted(()=>({ features:vi.fn(), mutation:vi.fn(), projection:vi.fn(), query:vi.fn(), enabled:vi.fn(), googleInspection:vi.fn(), graphInspection:vi.fn(), recovery:vi.fn() }));
vi.mock('../middleware/auth.js',()=>({requireAuth:(req:{session?:{userId:string}},_:unknown,next:()=>void)=>{req.session={userId:'user'};next();}}));
vi.mock('../services/accountProviderFeatures.js',()=>({describeAccountProviderFeatures:m.features}));
vi.mock('../services/providerSwitches.js',()=>({providerIntegrationsEnabled:m.enabled}));
vi.mock('../services/calendarCollectionMutation.js',()=>({runCalendarCollectionMutation:m.mutation,CalendarCollectionMutationValidationError:class extends Error { code='VALIDATION_ERROR'; }}));
vi.mock('../services/calendarCollectionProjection.js',()=>({projectCalendarCollection:m.projection}));
vi.mock('../services/db.js',()=>({query:m.query}));
vi.mock('../services/providers/google/googleCalendarManagement.js',()=>({inspectGoogleCalendarManagement:m.googleInspection}));
vi.mock('../services/providers/microsoft/graphCalendarManagement.js',()=>({inspectGraphCalendarManagement:m.graphInspection}));
vi.mock('../services/calendarCollectionRecovery.js',()=>({recoverUnknownCalendarDeletion:m.recovery}));
import router, {describeCalendarCollectionDeletion} from './accountsCalendarManagement.js';
const account='11111111-1111-4111-8111-111111111111', connection='22222222-2222-4222-8222-222222222222', collection='33333333-3333-4333-8333-333333333333';
let server:Server, base:string;
const feature=(overrides:Record<string,unknown>={})=>({provider:'google',calendar:{enabled:true,connectionId:connection,calendarManagement:{authorized:true,missingScopes:[]},...overrides}});
beforeAll(async()=>{const app=express();app.use(express.json());app.use(router);await new Promise<void>((resolve,reject)=>{server=app.listen(0,()=>resolve());server.once('error',reject);});base=`http://127.0.0.1:${listeningPort(server)}`;});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{vi.clearAllMocks();m.enabled.mockReturnValue(true);m.recovery.mockResolvedValue(null);m.features.mockResolvedValue(feature());m.mutation.mockResolvedValue({status:'confirmed',operationId:'op',replayed:false,value:{provider:'google',action:'create',remoteCalendarId:'remote',name:'Name'}});m.projection.mockResolvedValue({state:'projected',collectionId:collection,localCalendarId:'calendar'});m.query.mockResolvedValue({rows:[{id:collection,local_calendar_id:'calendar',remote_id:'remote',source:'google',name:'Name',provider_user_id:null}]});});
describe('account calendar lifecycle router',()=>{
 it('creates against server-resolved account connection and returns projected identifiers',async()=>{const res=await fetch(`${base}/${account}/provider-calendars`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Name',idempotencyKey:'key'})});expect(res.status).toBe(200);expect(await res.json()).toMatchObject({state:'confirmed',collectionId:collection});expect(m.mutation).toHaveBeenCalledWith(expect.objectContaining({accountId:account,connectionId:connection,provider:'google',action:'create'}));expect(m.mutation.mock.calls[0][0]).not.toHaveProperty('remoteCalendarId');});
 it('does not accept lifecycle action when disabled or consent/connection are unresolved',async()=>{for(const current of [feature({enabled:false}),feature({calendarManagement:{authorized:false,missingScopes:['x']}}),feature({connectionId:null})]){m.features.mockResolvedValueOnce(current);const res=await fetch(`${base}/${account}/provider-calendars`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'N',idempotencyKey:'k'})});expect([403,409]).toContain(res.status);}expect(m.mutation).not.toHaveBeenCalled();});
 it('maps journal pending and conflict without falsely reporting projection',async()=>{m.mutation.mockResolvedValueOnce({status:'pending',operationId:'op',replayed:true}).mockResolvedValueOnce({status:'conflict',operationId:'op',replayed:true,code:'idempotency_key_reused'});for(const [code,state] of [[202,'pending'],[409,'conflict']] as const){const res=await fetch(`${base}/${account}/provider-calendars`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'N',idempotencyKey:'k'})});const body=await res.json() as {state?: string};expect(res.status).toBe(code);expect(body.state).toBe(state);}expect(m.projection).not.toHaveBeenCalled();});
 it('deletes by scoped local collection and derives Graph identity only from provider connection',async()=>{m.features.mockResolvedValue(feature());m.query.mockResolvedValue({rows:[{id:collection,local_calendar_id:'calendar',remote_id:'opaque',source:'google',name:'Name',provider_user_id:null}]});m.mutation.mockResolvedValue({status:'confirmed',operationId:'op',replayed:false,value:{provider:'google',action:'delete',remoteCalendarId:'opaque',name:null}});const res=await fetch(`${base}/${account}/provider-calendars/${collection}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'key',confirmName:'Name'})});expect(res.status).toBe(200);expect(m.query.mock.calls[0][1]).toEqual([collection,'user',connection,account]);expect(m.mutation).toHaveBeenCalledWith(expect.objectContaining({remoteCalendarId:'opaque',connectionId:connection}));});
 it('does not mutate a foreign or connection-mismatched collection',async()=>{m.query.mockResolvedValue({rows:[]});const res=await fetch(`${base}/${account}/provider-calendars/${collection}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'key',confirmName:'Name'})});expect(res.status).toBe(404);expect(m.mutation).not.toHaveBeenCalled();});
});

describe('collection deletion confirmation and recovery', () => {
 const remove = (body: unknown) => fetch(`${base}/${account}/provider-calendars/${collection}`, {method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 it('requires the exact current calendar name before dispatch', async () => {
   for (const confirmName of [undefined,'Different']) expect((await remove({idempotencyKey:'key',confirmName})).status).toBe(400);
   expect(m.mutation).not.toHaveBeenCalled();
 });
 it('replays a scoped committed delete after its local projection disappeared', async () => {
   m.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'saved-op',status:'committed',result:{provider:'google',action:'delete',remoteCalendarId:'remote'}}]});
   const result = await remove({idempotencyKey:'key'});
   expect(result.status).toBe(200);
   expect(await result.json()).toMatchObject({state:'confirmed',replayed:true,operationId:'saved-op'});
   expect(m.mutation).not.toHaveBeenCalled();
   expect(m.query.mock.calls[1][1]).toEqual(['user',account,connection,'key',collection,'google']);
   expect(m.projection).toHaveBeenCalledWith(expect.objectContaining({operationId:'saved-op',value:expect.objectContaining({action:'delete',remoteCalendarId:'remote'})}));
 });
 it('reports a projection failure as pending without losing the confirmed remote operation', async () => {
   m.mutation.mockResolvedValue({status:'confirmed',operationId:'op',replayed:false,value:{provider:'google',action:'delete',remoteCalendarId:'remote',name:null}});
   m.projection.mockResolvedValue({state:'pending',collectionId:null,localCalendarId:null});
   const result=await remove({idempotencyKey:'key',confirmName:'Name'});
   expect(result.status).toBe(202);
   expect(await result.json()).toMatchObject({state:'pending',code:'PROJECTION_PENDING'});
 });
 it('checks an unknown missing projection with read-only recovery and projects only confirmed absence',async()=>{
   m.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'saved-op',status:'outcome_unknown',result:null}]});
   m.recovery.mockResolvedValue({provider:'google',action:'delete',remoteCalendarId:'remote',name:null});
   const result=await remove({idempotencyKey:'key'});
   expect(result.status).toBe(200);
   expect(await result.json()).toMatchObject({state:'confirmed',replayed:true});
   expect(m.recovery).toHaveBeenCalledWith({operationId:'saved-op',userId:'user',accountId:account,connectionId:connection,provider:'google'});
   expect(m.mutation).not.toHaveBeenCalled();
   expect(m.projection).toHaveBeenCalledOnce();
 });
 it('retains unknown outcomes without attempting projection or another mutation', async () => {
   m.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'saved-op',status:'outcome_unknown',result:null}]});
   const result=await remove({idempotencyKey:'key'});
   expect(result.status).toBe(502);
   expect(await result.json()).toMatchObject({state:'outcome_unknown'});
   expect(m.mutation).not.toHaveBeenCalled();
   expect(m.projection).not.toHaveBeenCalled();
 });
});

describe('provider calendar deletion capabilities', () => {
 const row={source:'google',account_id:account,connection_id:connection,remote_id:'remote'};
 it('requires current account authorization and canonical provider protection', async()=>{
   m.googleInspection.mockResolvedValue({canDelete:true});
   expect(await describeCalendarCollectionDeletion('user',row)).toEqual({supported:true});
   m.googleInspection.mockResolvedValue({canDelete:false,reason:'primary_calendar'});
   expect(await describeCalendarCollectionDeletion('user',row)).toEqual({supported:false,reason:'The default calendar cannot be deleted.'});
 });
 it('never treats missing permission or a failed metadata read as support', async()=>{
   m.features.mockResolvedValueOnce(feature({calendarManagement:{authorized:false}}));
   expect(await describeCalendarCollectionDeletion('user',row)).toMatchObject({supported:false});
   expect(m.googleInspection).not.toHaveBeenCalled();
   m.googleInspection.mockRejectedValue(new Error('timeout'));
   expect(await describeCalendarCollectionDeletion('user',row)).toMatchObject({supported:false,reason:expect.any(String)});
 });
 it('refuses a mismatched account connection before provider IO', async()=>{
   expect(await describeCalendarCollectionDeletion('user',{...row,connection_id:'other'})).toMatchObject({supported:false});
   expect(m.googleInspection).not.toHaveBeenCalled();
 });
});
