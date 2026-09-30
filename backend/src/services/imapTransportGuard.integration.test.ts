import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll,afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('../routes/oauth.js',()=>({refreshMicrosoftToken:vi.fn()}));
vi.mock('imapflow',()=>({ImapFlow:vi.fn(()=>{throw new Error('Unexpected IMAP network access');})}));
import {pool,query} from './db.js';
import {ImapManager} from './imapManager.js';
import {assertCurrentImapAccount,readCurrentImapAccount} from './imapTransportGuard.js';

const enabled=Boolean(process.env.DB_HOST&&process.env.DB_NAME);
if(process.env.REQUIRE_NATIVE_CUTOVER_POSTGRES==='1'&&!enabled)throw new Error('Native transport regression requires PostgreSQL');
describe.skipIf(!enabled)('native cutover generation and status fencing in PostgreSQL',()=>{
  let owner:string,other:string,id:string,manager:ImapManager;
  const old=()=>({id,user_id:owner,protocol:'imap',mail_transport:'imap_smtp',imap_host:'imap.gmail.com',enabled:true,transport_generation:'1'});
  beforeEach(async()=>{
    owner=randomUUID();other=randomUUID();id=randomUUID();
    manager=new ImapManager({clients:new Set()});
    clearInterval(manager._healthCheckTimer);clearInterval(manager._stalenessCheckTimer);clearInterval(manager._snippetSchedulerTimer);
    manager.broadcast=vi.fn();
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'unused'),($3,$4,'unused')",[owner,`native-${owner}`,other,`other-${other}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,imap_host) VALUES($1,$2,'Test','synthetic@example.test','imap','imap_smtp','imap.gmail.com')",[id,owner]);
  });
  afterEach(async()=>{await manager.disconnectAccount(id);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,other]]);vi.restoreAllMocks();});
  afterAll(async()=>{await pool.end();});
  async function native(transport='gmail_api'){
    await query("UPDATE email_accounts SET mail_transport=$2,protocol=$2,imap_host=NULL,transport_generation=transport_generation+1,sync_error=NULL WHERE id=$1",[id,transport]);
  }
  it('retains real IMAP failures, clears on real recovery, and enforces ownership',async()=>{
    await expect(assertCurrentImapAccount(old())).resolves.toBeUndefined();
    expect(await readCurrentImapAccount(old())).toMatchObject({id,mail_transport:'imap_smtp'});
    await expect(assertCurrentImapAccount({...old(),user_id:other})).rejects.toMatchObject({code:'IMAP_ACCOUNT_CHANGED'});
    await manager._recordAccountError({...old(),user_id:other},'foreign error');
    expect(manager.broadcast).not.toHaveBeenCalled();
    await manager._recordAccountError(old(),'Authentication failed');
    expect((await query('SELECT sync_error FROM email_accounts WHERE id=$1',[id])).rows[0].sync_error).toBe('Authentication failed');
    expect(manager.broadcast).toHaveBeenCalledWith({type:'account_error',accountId:id,error:'Authentication failed'},owner);
    await manager._clearAccountError(old());
    expect((await query('SELECT sync_error FROM email_accounts WHERE id=$1',[id])).rows[0].sync_error).toBeNull();
  });
  it.each(['gmail_api','microsoft_graph'])('blocks native %s even with legacy protocol=imap, including delayed status writes',async transport=>{
    await native(transport);
    await query("UPDATE email_accounts SET protocol='imap',sync_error='provider diagnostic' WHERE id=$1",[id]);
    await expect(assertCurrentImapAccount(old())).rejects.toMatchObject({code:'IMAP_ACCOUNT_CHANGED'});
    expect(await readCurrentImapAccount(old())).toBeNull();
    await manager._recordAccountError(old(),'Host must be a string');await manager._clearAccountError(old());
    expect((await query('SELECT sync_error FROM email_accounts WHERE id=$1',[id])).rows[0].sync_error).toBe('provider diagnostic');
    expect(manager.broadcast).not.toHaveBeenCalled();
    await manager._syncTick(old());expect(await manager.connectAccount(old())).toBe(false);
    expect(manager.syncIntervals.size).toBe(0);expect(manager.connections.size).toBe(0);
  });
  it('rejects work from an old generation after switching back to IMAP',async()=>{
    await native();await query("UPDATE email_accounts SET protocol='imap',mail_transport='imap_smtp',imap_host='imap.gmail.com',transport_generation=3,sync_error='new generation' WHERE id=$1",[id]);
    await manager._recordAccountError(old(),'late old failure');await manager._clearAccountError(old());
    expect(manager.broadcast).not.toHaveBeenCalled();
    expect((await query('SELECT sync_error FROM email_accounts WHERE id=$1',[id])).rows[0].sync_error).toBe('new generation');
    await expect(assertCurrentImapAccount(old())).rejects.toMatchObject({code:'IMAP_ACCOUNT_CHANGED'});
    await expect(assertCurrentImapAccount({...old(),transport_generation:'3'})).resolves.toBeUndefined();
  });
  it('re-evaluates a blocked legacy error write after the cutover commits',async()=>{
    const guard=await pool.connect();let operation:Promise<void>|undefined;
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      await guard.query('BEGIN');
      await guard.query("UPDATE email_accounts SET protocol='gmail_api',mail_transport='gmail_api',imap_host=NULL,transport_generation=2,sync_error=NULL WHERE id=$1",[id]);
      operation=manager._recordAccountError(old(),'Host must be a string');
      // Wait until the production UPDATE is actually blocked on the cutover row.
      let waiting=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const r=await query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'UPDATE email_accounts SET sync_error%') AS waiting");
        if(r.rows[0].waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await guard.query('COMMIT');await operation;
      expect((await query('SELECT sync_error FROM email_accounts WHERE id=$1',[id])).rows[0].sync_error).toBeNull();
      expect(manager.broadcast).not.toHaveBeenCalled();
    }finally{await guard.query('ROLLBACK');guard.release();await operation;}
  },10000);
  it('migration clears only the known native-host artifact and leaves provider diagnostics and data intact',async()=>{
    const pc=randomUUID(),message=randomUUID();
    await query("INSERT INTO provider_connections(id,user_id,provider,status) VALUES($1,$2,'google','reauth_required')",[pc,owner]);
    await query("INSERT INTO messages(id,account_id,uid,folder,subject,body_text) VALUES($1,$2,1,'INBOX','Kept','Kept body')",[message,id]);
    await native();
    await query("UPDATE email_accounts SET provider_connection_id=$2,sync_error='Host must be a string',migration_error_code='PROVIDER_AUTH_REQUIRED' WHERE id=$1",[id,pc]);
    const cases=[['imap_smtp','Host must be a string'],['gmail_api','invalid_grant'],['microsoft_graph','Host must be a string']];
    const others=[];
    for(const [transport,error] of cases){const key=randomUUID();others.push(key);await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,sync_error) VALUES($1,$2,'Other',$3,'imap',$4,$5)",[key,other,`${key}@example.test`,transport,error]);}
    const migration=await readFile(new URL('../../migrations/0166_native_account_stale_imap_error.sql',import.meta.url),'utf8');
    await query(migration);await query(migration);
    expect((await query('SELECT sync_error,migration_error_code,provider_connection_id FROM email_accounts WHERE id=$1',[id])).rows[0]).toEqual({sync_error:null,migration_error_code:'PROVIDER_AUTH_REQUIRED',provider_connection_id:pc});
    expect((await query('SELECT status FROM provider_connections WHERE id=$1',[pc])).rows[0].status).toBe('reauth_required');
    expect((await query('SELECT subject,body_text FROM messages WHERE id=$1',[message])).rows[0]).toEqual({subject:'Kept',body_text:'Kept body'});
    expect((await query('SELECT id,sync_error FROM email_accounts WHERE id=ANY($1::uuid[])',[others])).rows).toEqual(expect.arrayContaining([
      {id:others[0],sync_error:'Host must be a string'},{id:others[1],sync_error:'invalid_grant'},{id:others[2],sync_error:null},
    ]));
  });
});
