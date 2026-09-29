import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, withTransaction } from './db.js';
import { storeOAuthGrant, upsertProviderConnection, GOOGLE_GRANT_AUDIENCE, MICROSOFT_GRANT_AUDIENCE, GOOGLE_ISSUER, MICROSOFT_ISSUER } from './providerAuthService.js';
import { runCalendarCollectionMutation, type CalendarCollectionMutationInput, type CalendarCollectionMutationOptions } from './calendarCollectionMutation.js';
import { recoverUnknownCalendarDeletion } from './calendarCollectionRecovery.js';
import { ensureGoogleCalendarCollection } from './providers/google/googleCalendarSync.js';
import { ensureGraphCalendarCollection } from './providers/microsoft/graphCalendarSync.js';

const suite=process.env.DB_HOST&&process.env.DB_NAME?describe:describe.skip;
const config={clientId:'synthetic-recovery',clientSecret:'synthetic',redirectUri:'https://example.test/callback',tenantId:'common',providerRedirectUri:''};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

suite.each(['google','microsoft'] as const)('unknown %s calendar DELETE recovery (PostgreSQL + fake HTTP)',provider=>{
 let userId:string,accountId:string,connectionId:string,collectionId:string,calendarId:string,operationId:string;
 let originalKey:string|undefined;
 let snapshots:unknown[],httpStatus:number,deleteCalls:number,requests:string[];
 let beforeRead:(()=>Promise<void>)|undefined;
 const envelope=(ids:string[])=>provider==='google'?{items:ids.map(id=>({id}))}:{value:ids.map(id=>({id}))};
 const fetchImpl:typeof fetch=async(input,init)=>{
   const url=String(input); requests.push(`${init?.method??'GET'} ${url}`);
   if (init?.method && init.method!=='GET') throw new Error('Recovery must only read from the provider');
   await beforeRead?.();
   return json(snapshots.length>1?snapshots.shift():snapshots[0],httpStatus);
 };
 const options=():CalendarCollectionMutationOptions=>({googleApi:{config,fetchImpl},graphApi:{config,fetchImpl},calls:{
   deleteGoogle:async()=>{deleteCalls++;throw new TypeError('Synthetic socket lost after dispatch');},
   deleteGraph:async()=>{deleteCalls++;throw new TypeError('Synthetic socket lost after dispatch');},
 }});
 const input=():CalendarCollectionMutationInput=>({userId,accountId,connectionId,provider,action:'delete',collectionId,localCalendarId:calendarId,remoteCalendarId:'secondary',verifiedMailboxIdentity:'owner@example.test',idempotencyKey:'delete-unknown'});
 const recover=()=>recoverUnknownCalendarDeletion({operationId,userId,accountId,connectionId,provider},{...options(),maxRecoveryPages:2});
 const journal=async()=>(await query<{status:string}>('SELECT status FROM provider_operations WHERE id=$1',[operationId])).rows[0]?.status;
 const assertRetained=async()=>{
   expect(await journal()).toBe('outcome_unknown');
   expect((await query('SELECT id FROM calendars WHERE id=$1',[calendarId])).rows).toHaveLength(1);
   expect((await query('SELECT id FROM integration_collections WHERE id=$1 AND enabled AND local_calendar_id=$2',[collectionId,calendarId])).rows).toHaveLength(1);
   expect(deleteCalls).toBe(1);
 };
 beforeEach(async()=>{
   originalKey=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
   userId=randomUUID();accountId=randomUUID();deleteCalls=0;requests=[];httpStatus=200;snapshots=[envelope([])];beforeRead=undefined;
   await query('INSERT INTO users(id,username) VALUES($1,$2)',[userId,`calendar-recovery-${userId}`]);
   connectionId=await withTransaction(async client=>{
     const id=await upsertProviderConnection(client,{userId,provider,issuer:provider==='google'?GOOGLE_ISSUER:MICROSOFT_ISSUER,subject:randomUUID()});
     await storeOAuthGrant(client,{connectionId:id,audience:provider==='google'?GOOGLE_GRANT_AUDIENCE:MICROSOFT_GRANT_AUDIENCE,accessToken:'synthetic-only',refreshToken:null,expiresAt:new Date(Date.now()+3600000),scopes:provider==='google'?['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.calendars']:['https://graph.microsoft.com/Calendars.ReadWrite'],clientIdAtIssue:config.clientId});
     return id;
   });
   await query("INSERT INTO email_accounts(id,user_id,provider_connection_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,auth_user,auth_pass) VALUES($1,$2,$3,'Synthetic recovery','owner@example.test','example.test',993,'example.test',587,'test','x')",[accountId,userId,connectionId]);
   await query("INSERT INTO account_provider_feature_settings(account_id,feature,enabled) VALUES($1,'calendars',true)",[accountId]);
   await withTransaction(client=>provider==='google'
     ?ensureGoogleCalendarCollection(client,{userId,connectionId,entry:{id:'secondary',summary:'Secondary',accessRole:'owner'}})
     :ensureGraphCalendarCollection(client,{userId,connectionId,entry:{id:'secondary',name:'Secondary',isDefaultCalendar:false,canEdit:true,owner:null}}));
   const rows=await query<{id:string;local_calendar_id:string}>('SELECT id,local_calendar_id FROM integration_collections WHERE user_id=$1 AND connection_id=$2',[userId,connectionId]);
   collectionId=rows.rows[0]!.id;calendarId=rows.rows[0]!.local_calendar_id;
   const result=await runCalendarCollectionMutation(input(),options());
   expect(result.status).toBe('outcome_unknown');expect(result.operationId).toBeTruthy();operationId=result.operationId!;
 });
 afterEach(async()=>{
   await query('DELETE FROM users WHERE id=$1',[userId]);
   if(originalKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=originalKey;
 });
 it('confirms an unknown deletion from a complete absence and never dispatches DELETE twice',async()=>{
   const result=await runCalendarCollectionMutation(input(),options());
   expect(result).toMatchObject({status:'confirmed',replayed:true,operationId,value:{action:'delete',remoteCalendarId:'secondary'}});
   expect(await journal()).toBe('committed');
   expect((await query('SELECT id FROM calendars WHERE id=$1',[calendarId])).rows).toHaveLength(0);
   expect((await query('SELECT local_calendar_id,enabled FROM integration_collections WHERE id=$1',[collectionId])).rows).toEqual([{local_calendar_id:null,enabled:false}]);
   expect((await query('SELECT operation_id FROM calendar_collection_tombstones WHERE connection_id=$1',[connectionId])).rows).toEqual([{operation_id:operationId}]);
   expect((await runCalendarCollectionMutation(input(),options())).status).toBe('confirmed');
   expect(deleteCalls).toBe(1);expect(requests).toHaveLength(1);
 });
 it('retains a collection still present on a later complete page',async()=>{
   snapshots=provider==='google'?[{items:[],nextPageToken:'next'},envelope(['secondary'])]:[{value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next'},envelope(['secondary'])];
   expect(await recover()).toBeNull();await assertRetained();expect(requests).toHaveLength(2);
 });
 it('does not turn a capped snapshot into deletion confirmation',async()=>{
   snapshots=[provider==='google'?{items:[],nextPageToken:'next'}:{value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next'}];
   expect(await recover()).toBeNull();await assertRetained();
 });
 it.each([401,403,404,429,500])('does not confirm deletion on HTTP %i',async status=>{
   httpStatus=status;await expect(recover()).rejects.toBeInstanceOf(Error);await assertRetained();
 });
 it('rejects malformed success payloads',async()=>{
   snapshots=[{}];await expect(recover()).rejects.toMatchObject({code:'UPSTREAM_UNAVAILABLE'});await assertRetained();
 });
 it('fences account feature revocation during the read',async()=>{
   beforeRead=async()=>{await query("UPDATE account_provider_feature_settings SET enabled=false WHERE account_id=$1 AND feature='calendars'",[accountId]);};
   expect(await recover()).toBeNull();await assertRetained();
 });
 it('fences revoked current scopes during the read despite historical write scopes',async()=>{
   beforeRead=async()=>{await query("UPDATE oauth_grants SET current_scopes='{}' WHERE connection_id=$1",[connectionId]);};
   expect(await recover()).toBeNull();await assertRetained();
 });
 it('fences a revoked grant status during the read',async()=>{
   beforeRead=async()=>{await query("UPDATE oauth_grants SET status='revoked' WHERE connection_id=$1",[connectionId]);};
   expect(await recover()).toBeNull();await assertRetained();
 });
 it('rejects another account or connection before provider IO',async()=>{
   for(const override of [{accountId:randomUUID()},{connectionId:randomUUID()},{userId:randomUUID()}])expect(await recoverUnknownCalendarDeletion({operationId,userId,accountId,connectionId,provider,...override},options())).toBeNull();
   expect(requests).toHaveLength(0);await assertRetained();
 });
 it('does not modify the journal or projection after losing the discovery lease',async()=>{
   beforeRead=async()=>{await query("UPDATE sync_states SET running_generation=running_generation+1 WHERE connection_id=$1 AND coverage='collection_discovery'",[connectionId]);};
   await expect(recover()).rejects.toMatchObject({code:'SYNC_LEASE_LOST'});await assertRetained();
 });
});
