import { EventEmitter } from 'node:events';
import { mockImapClient } from '../test/imapClient.js';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('imapflow',()=>({ImapFlow:vi.fn()}));
vi.mock('./db.js',()=>({query:vi.fn()}));
vi.mock('../routes/oauth.js',()=>({refreshMicrosoftToken:vi.fn()}));
vi.mock('./connectionPolicy.js',()=>({getConnectionPolicy:vi.fn(async()=>({allowPrivateHosts:false}))}));
vi.mock('./hostValidation.js',()=>({validateHost:vi.fn(),resolveForConnection:vi.fn(async(host:unknown)=>{
  if(typeof host!=='string')throw new TypeError('Host must be a string');
  return {host,servername:host};
}),createPinnedLookup:vi.fn()}));
import {query} from './db.js';
import {resolveForConnection} from './hostValidation.js';
import {ImapFlow} from 'imapflow';
import {ImapManager} from './imapManager.js';
const old={id:'account',user_id:'owner',protocol:'imap',mail_transport:'imap_smtp',transport_generation:'1',enabled:true,imap_tls:true,imap_host:'imap.gmail.com'};
let manager:ImapManager;
beforeEach(()=>{
  vi.clearAllMocks();vi.mocked(query).mockReset();manager=new ImapManager({clients:new Set()});
  clearInterval(manager._healthCheckTimer);clearInterval(manager._stalenessCheckTimer);clearInterval(manager._snippetSchedulerTimer);
  manager.broadcast=vi.fn();
  vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
});
afterEach(async()=>{await manager.disconnectAccount(old.id);vi.restoreAllMocks();});
describe('native cutover vs legacy IMAP callbacks',()=>{
  it.each(['gmail_api','microsoft_graph'])('does not resolve an IMAP host after a queued reconnect finds %s',async transport=>{
    const native={...old,protocol:transport,mail_transport:transport,transport_generation:'2',imap_host:null};
    vi.mocked(query).mockResolvedValue({rows:[native]});
    await manager._syncTick(old);
    expect(resolveForConnection).not.toHaveBeenCalled();expect(ImapFlow).not.toHaveBeenCalled();
    expect(vi.mocked(query).mock.calls.some(([sql])=>sql.includes('SET sync_error'))).toBe(false);
    expect(manager.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({type:'account_error'}),'owner');
    expect(manager.syncingAccounts.has(old.id)).toBe(false);
  });
  it.each(['gmail_api','microsoft_graph'])('refuses a direct legacy connect for %s without recording an error',async transport=>{
    await manager.connectAccount({...old,mail_transport:transport,imap_host:null});
    expect(resolveForConnection).not.toHaveBeenCalled();expect(ImapFlow).not.toHaveBeenCalled();
    expect(manager.broadcast).not.toHaveBeenCalled();
  });
  it('stops a surviving persistent tick and poll timer after migration',async()=>{
    const native={...old,mail_transport:'gmail_api',protocol:'gmail_api',imap_host:null,transport_generation:'2'};
    vi.mocked(query).mockResolvedValue({rows:[native]});
    const client=mockImapClient({logout:vi.fn(async()=>{})});
    manager.connections.set(old.id,client);
    manager.syncIntervals.set(old.id,setTimeout(()=>{},60_000));
    manager.syncMessages=vi.fn();
    await manager._syncTick(old);
    await manager._pollOnlyTick(old);
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(manager.connections.has(old.id)).toBe(false);expect(manager.syncIntervals.has(old.id)).toBe(false);
    expect(manager.syncMessages).not.toHaveBeenCalled();expect(resolveForConnection).not.toHaveBeenCalled();
  });
  it('rejects a startup callback queued with the old IMAP row before resolving its endpoint',async()=>{
    vi.mocked(query).mockResolvedValue({rows:[{...old,protocol:'gmail_api',mail_transport:'gmail_api',imap_host:null,transport_generation:'2'}]});
    expect(await manager.connectAccount(old)).toBe(false);
    expect(resolveForConnection).not.toHaveBeenCalled();expect(ImapFlow).not.toHaveBeenCalled();
    expect(manager.connectingAccounts.has(old.id)).toBe(false);
  });
  it('drops the socket when cutover commits while the handshake is in flight',async()=>{
    let switched=false;
    const close=vi.fn();
    vi.mocked(query).mockImplementation(async sql=>{
      if(sql.startsWith('SELECT *'))return {rows:[old]};
      if(sql.startsWith('SELECT id'))return {rows:switched?[]:[{id:old.id}]};
      return {rows:[]};
    });
    vi.mocked(ImapFlow).mockImplementation(function(){
      return mockImapClient(Object.assign(new EventEmitter(),{connect:vi.fn(async()=>{switched=true;}),close,logout:vi.fn(async()=>{})}));
    });
    expect(await manager.connectAccount(old)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.connections.has(old.id)).toBe(false);expect(manager.syncIntervals.has(old.id)).toBe(false);
    expect(manager.broadcast).not.toHaveBeenCalled();
    expect(vi.mocked(query).mock.calls.some(([sql])=>sql.includes('SET sync_error'))).toBe(false);
  });
  it('does not broadcast a late old-transport failure or success rejected by the SQL generation fence',async()=>{
    vi.mocked(query).mockResolvedValue({rows:[]});
    await manager._recordAccountError(old,'Host must be a string');
    await manager._clearAccountError(old);
    expect(manager.broadcast).not.toHaveBeenCalled();expect(manager._syncErrorState.has(old.id)).toBe(false);
    for(const [sql,args] of vi.mocked(query).mock.calls){
      expect(sql).toContain('AND user_id');expect(sql).toContain('transport_generation');
      expect(sql).toContain("mail_transport = 'imap_smtp'");expect(sql).toContain('RETURNING id');
      expect(args).toContain('owner');
    }
  });

  it('does not tear down a newer IMAP generation because an old timer wakes up',async()=>{
    vi.mocked(query).mockResolvedValue({rows:[{...old,transport_generation:'3'}]});
    const client=mockImapClient({logout:vi.fn(async()=>{})});manager.connections.set(old.id,client);
    await manager._syncTick(old);expect(await manager.connectAccount(old)).toBe(false);
    expect(manager.connections.get(old.id)).toBe(client);expect(client.logout).not.toHaveBeenCalled();
    expect(manager.broadcast).not.toHaveBeenCalled();expect(resolveForConnection).not.toHaveBeenCalled();
  });

});
