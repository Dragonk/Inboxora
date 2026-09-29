import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { query } from '../services/db.js';
import { listeningPort } from '../test/net.js';

const fixture = vi.hoisted(() => ({ userId: '', connectionId: '', sessionUserId: '' }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { session?: { userId: string } }, _res: unknown, next: () => void) => { req.session = { userId: fixture.sessionUserId }; next(); } }));
vi.mock('../services/providerSwitches.js', () => ({ providerIntegrationsEnabled: () => true }));
vi.mock('../services/accountProviderFeatures.js', () => ({ describeAccountProviderFeatures: async () => ({ provider: 'google', calendar: { enabled: true, connectionId: fixture.connectionId, calendarManagement: { authorized: true } } }) }));
// A replay must not issue provider IO, even when there is no longer a local resource.
const mutation = vi.hoisted(() => vi.fn(() => { throw new Error('A replay attempted provider IO'); }));
vi.mock('../services/calendarCollectionMutation.js', async importOriginal => ({ ...await importOriginal<typeof import('../services/calendarCollectionMutation.js')>(), runCalendarCollectionMutation: mutation }));
import router from './accountsCalendarManagement.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
const userId = randomUUID(), foreignUserId = randomUUID(), accountId = randomUUID(), connectionId = randomUUID(), collectionId = randomUUID(), operationId = randomUUID(), localCalendarId = randomUUID();
let server: Server;
let base: string;

suite('calendar deletion HTTP recovery with PostgreSQL', () => {
  beforeAll(async () => {
    fixture.userId = userId; fixture.sessionUserId = userId; fixture.connectionId = connectionId;
    await query("INSERT INTO users(id,username) VALUES ($1,$2),($3,$4)", [userId, `route-native-${userId}`, foreignUserId, `route-native-${foreignUserId}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,auth_user,auth_pass) VALUES($1,$2,'Synthetic recovery','route@example.test','example.test',993,'example.test',587,'test','x')", [accountId,userId]);
    await query("INSERT INTO provider_connections(id,user_id,provider) VALUES($1,$2,'google')", [connectionId,userId]);
    await query("INSERT INTO integration_collections(id,user_id,account_id,connection_id,kind,remote_id,enabled) VALUES($1,$2,$3,$4,'calendar','synthetic-deleted-calendar',false)", [collectionId,userId,accountId,connectionId]);
    await query(`INSERT INTO provider_operations(id,user_id,account_id,connection_id,collection_id,resource_type,resource_id,operation,idempotency_key,status,payload,result)
      VALUES($1,$2,$3,$4,$5,'calendar_collection',$6,'delete','delete-key','committed',$7::jsonb,$8::jsonb)`,
    [operationId,userId,accountId,connectionId,collectionId,localCalendarId,JSON.stringify({version:1,provider:'google',action:'delete',accountId,connectionId,collectionId,localCalendarId,remoteCalendarId:'synthetic-deleted-calendar',name:null,verifiedMailboxIdentity:null}),JSON.stringify({provider:'google',action:'delete',remoteCalendarId:'synthetic-deleted-calendar',name:null})]);
    const app=express(); app.use(express.json()); app.use(router);
    await new Promise<void>((resolve,reject)=>{ server=app.listen(0,()=>resolve());server.once('error',reject); });
    base=`http://127.0.0.1:${listeningPort(server)}`;
  });
  beforeEach(() => { fixture.sessionUserId=userId; mutation.mockClear(); });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[userId,foreignUserId]]);
  });
  const remove=(key='delete-key')=>fetch(`${base}/${accountId}/provider-calendars/${collectionId}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:key})});
  it('finishes confirmed deletion from the journal with no remaining local calendar and no provider call',async()=>{
    const response=await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({state:'confirmed',operationId,replayed:true});
    expect((await query('SELECT state FROM calendar_collection_projection_receipts WHERE operation_id=$1',[operationId])).rows).toEqual([{state:'projected'}]);
    expect((await query('SELECT local_calendar_id,enabled FROM integration_collections WHERE id=$1',[collectionId])).rows).toEqual([{local_calendar_id:null,enabled:false}]);
    expect(mutation).not.toHaveBeenCalled();
    expect((await remove()).status).toBe(200);
  });
  it('cannot replay a foreign user journal entry or a different idempotency key',async()=>{
    fixture.sessionUserId=foreignUserId;
    expect((await remove()).status).toBe(404);
    fixture.sessionUserId=userId;
    expect((await remove('unrelated-key')).status).toBe(404);
    expect(mutation).not.toHaveBeenCalled();
  });
  it('rejects a journal result belonging to a different resolved connection',async()=>{
    fixture.connectionId=randomUUID();
    try { expect((await remove()).status).toBe(404); } finally { fixture.connectionId=connectionId; }
    expect(mutation).not.toHaveBeenCalled();
  });
});
