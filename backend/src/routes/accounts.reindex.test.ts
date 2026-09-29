import 'express-async-errors';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), transport: vi.fn(), backfill: vi.fn(), running: new Set<string>(),
  gmailFolders: vi.fn(), gmailMessages: vi.fn(), graphFolders: vi.fn(), graphMessages: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: {session?: {userId:string}}, _res: unknown, next: () => void) => { req.session={userId:'11111111-1111-4111-8111-111111111111'};next(); }, requireAdmin: (_req:unknown,_res:unknown,next:()=>void)=>next() }));
vi.mock('../index.js', () => ({ imapManager: { backfillAllRunning: mocks.running, backfillAllFolders: mocks.backfill } }));
vi.mock('../services/mailTransportTarget.js', () => ({ resolveMailTransportForSync: mocks.transport }));
vi.mock('../services/providers/google/gmailMailSync.js', () => ({ syncGmailMailLabelsForAccount:mocks.gmailFolders,syncGmailMailMessagesForAccount:mocks.gmailMessages }));
vi.mock('../services/providers/microsoft/graphMailSync.js', () => ({ syncGraphMailFoldersForAccount:mocks.graphFolders,syncGraphMailMessagesForAccount:mocks.graphMessages }));
vi.mock('../services/providerSyncScheduler.js', () => ({ runProviderSyncForHint: vi.fn(), providerSyncIntervalMinutes: vi.fn(()=>15), startProviderSyncScheduler:vi.fn(),stopProviderSyncScheduler:vi.fn(),listProviderSyncTargets:vi.fn(async()=>[]) }));
import express from 'express';
import routes from './accounts.js';
let server:Server;let base='';
const account={id:'22222222-2222-4222-8222-222222222222',user_id:'11111111-1111-4111-8111-111111111111',enabled:true};
beforeEach(async()=>{
  vi.clearAllMocks();mocks.running.clear();
  mocks.query.mockImplementation(async (sql:string)=>({rows:sql.startsWith('SELECT * FROM email_accounts')?[account]:[]}));
  mocks.transport.mockResolvedValue({kind:'imap',account});
  mocks.backfill.mockResolvedValue({ran:true,failedFolders:0,skippedFolders:0});
  for(const fn of [mocks.gmailFolders,mocks.gmailMessages,mocks.graphFolders,mocks.graphMessages])fn.mockResolvedValue(undefined);
  if(!server){const app=express();app.use(express.json());app.use('/api/accounts',routes);await new Promise<void>((resolve,reject)=>{server=app.listen(0,()=>resolve());server.once('error',reject);});base=`http://127.0.0.1:${listeningPort(server)}`;}
});
afterAll(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
const reindex=()=>fetch(`${base}/api/accounts/${account.id}/reindex`,{method:'POST'});
const completed=()=>mocks.query.mock.calls.filter(([sql])=>String(sql).includes('SET reindex_completed_at'));
const errors=()=>mocks.query.mock.calls.filter(([sql])=>String(sql).includes('SET reindex_error = $2'));
describe('reindex completion is earned, not inferred from a resolved promise',()=>{
  it('marks a completely successful IMAP backfill complete',async()=>{
    expect((await reindex()).status).toBe(202);
    await vi.waitFor(()=>expect(completed()).toHaveLength(1));
    expect(errors()).toHaveLength(0);
  });
  it.each([
    [{ran:true,failedFolders:2,skippedFolders:0},'REINDEX_FAILED'],
    [{ran:false,failedFolders:0,skippedFolders:0},'REINDEX_INCOMPLETE'],
    [{ran:true,failedFolders:0,skippedFolders:1},'REINDEX_INCOMPLETE'],
  ])('records an incomplete outcome %j without setting completion',async(outcome,code)=>{
    mocks.backfill.mockResolvedValue(outcome);
    expect((await reindex()).status).toBe(202);
    await vi.waitFor(()=>expect(errors()).toHaveLength(1));
    expect(errors()[0][1]).toEqual([account.id,code]);expect(completed()).toHaveLength(0);
  });
  it('does not enqueue a second IMAP request while its backfill is active',async()=>{
    mocks.running.add(account.id);const response=await reindex();
    expect(await response.json()).toEqual({ok:true,alreadyRunning:true});
    expect(mocks.backfill).not.toHaveBeenCalled();expect(completed()).toHaveLength(0);expect(errors()).toHaveLength(0);
  });
  it.each(['gmail','graph'])('uses the %s transport and lets its leased sync own completion',async kind=>{
    mocks.transport.mockResolvedValue({kind,connectionId:'connection',config:{}});
    expect((await reindex()).status).toBe(202);
    await vi.waitFor(()=>expect(kind==='gmail'?mocks.gmailMessages:mocks.graphMessages).toHaveBeenCalledOnce());
    expect(mocks.backfill).not.toHaveBeenCalled();expect(completed()).toHaveLength(0);
  });
  it('rejects an unavailable account before starting work',async()=>{
    mocks.query.mockResolvedValue({rows:[]});expect((await reindex()).status).toBe(404);
    expect(mocks.transport).not.toHaveBeenCalled();expect(mocks.backfill).not.toHaveBeenCalled();
  });
});
