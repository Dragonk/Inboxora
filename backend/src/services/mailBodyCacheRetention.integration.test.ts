import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,afterAll,describe,it,expect,vi} from 'vitest';
import {pool,query} from './db.js';
import {expireMailBodyCache,BODY_CACHE_RETENTION_BATCH} from './mailBodyCacheRetention.js';
import {prefetchVisibleBodies} from './mailBodyPrefetch.js';
import {RETENTION_KEYS} from './storageRetentionSettings.js';
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_NAME);
if(process.env.REQUIRE_STORAGE_POSTGRES==='1'&&!enabled)throw new Error('Cache retention tests need isolated PostgreSQL');
describe.skipIf(!enabled)('mail body cache expiry without mail deletion',()=>{
  let user:string,account:string,nextUid:number;
  beforeEach(async()=>{
    user=randomUUID();account=randomUUID();nextUid=1;
    await query('DELETE FROM system_settings WHERE key=ANY($1::text[])',[RETENTION_KEYS]);
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test-only')",[user,`cache-${user}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport) VALUES($1,$2,'Cache test','cache@example.test','imap','imap_smtp')",[account,user]);
    await query("INSERT INTO folders(account_id,path,name,uid_validity) VALUES($1,'INBOX','INBOX',1)",[account]);
  });
  afterEach(async()=>{await query('DELETE FROM users WHERE id=$1',[user]);await query('DELETE FROM system_settings WHERE key=ANY($1::text[])',[RETENTION_KEYS]);});
  afterAll(async()=>{await pool.end();});
  async function message(age=40){
    const id=randomUUID();
    await query(`INSERT INTO messages(id,account_id,uid,folder,subject,message_id,body_html,body_text,snippet,attachments,conversation_raw_headers,is_read,is_starred)
      VALUES($1,$2,$3,'INBOX','Keep subject',$4,'<p>Cached</p>','Cached','Keep preview','[{"part":"2","filename":"keep.pdf"}]','Subject: Keep',true,true)`,[id,account,nextUid++,`<${id}@test>`]);
    await query("UPDATE messages SET body_cache_refreshed_at=NOW()-$2*INTERVAL '1 day' WHERE id=$1",[id,age]);return id;
  }
  async function expire(){const c=await pool.connect();try{return await expireMailBodyCache(c);}finally{c.release();}}
  async function policy(days:number){await query("INSERT INTO system_settings(key,value) VALUES('mail_body_cache_days',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[String(days)]);}
  it('removes only expired body text/HTML and leaves mail identity, metadata and attachments intact',async()=>{
    const old=await message(),recent=await message(2);
    const before=(await query('SELECT id,subject,message_id,snippet,attachments,conversation_raw_headers,is_read,is_starred FROM messages WHERE id=$1',[old])).rows[0];
    const result=await expire();expect(result.evicted).toBe(1);expect(result.logicalBytes).toBe(Buffer.byteLength('<p>Cached</p>Cached'));
    expect((await query('SELECT id,subject,message_id,snippet,attachments,conversation_raw_headers,is_read,is_starred FROM messages WHERE id=$1',[old])).rows[0]).toEqual(before);
    expect((await query('SELECT body_html,body_text,gmail_reader_body_complete,gmail_rule_body_complete,graph_reader_body_complete FROM messages WHERE id=$1',[old])).rows[0])
      .toEqual({body_html:null,body_text:null,gmail_reader_body_complete:false,gmail_rule_body_complete:false,graph_reader_body_complete:false});
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[recent])).rows[0].body_text).toBe('Cached');
    expect(await expire()).toEqual({evicted:0,logicalBytes:0});
  });
  it('uses last opening or cache fill, never message date, Seen changes or sync metadata',async()=>{
    const id=await message();
    await query("UPDATE messages SET date='2000-01-01',body_last_opened_at=NOW()-INTERVAL '2 days',is_read=false,synced_at=NOW() WHERE id=$1",[id]);
    expect((await expire()).evicted).toBe(0);
    await query("UPDATE messages SET body_last_opened_at=NOW()-INTERVAL '31 days',is_read=true,synced_at=NOW() WHERE id=$1",[id]);
    expect((await expire()).evicted).toBe(1);
  });
  it('applies 0, 30 and 7 days without restarting and does not repopulate an expired cache on list prefetch',async()=>{
    const id=await message(14);await policy(0);expect((await expire()).evicted).toBe(0);
    await policy(30);expect((await expire()).evicted).toBe(0);
    await policy(7);expect((await expire()).evicted).toBe(1);
    const read=vi.fn(async()=>({html:null,text:'Fetched'}));
    await prefetchVisibleBodies({id:account,user_id:user,mail_transport:'imap_smtp'},[id],read);expect(read).not.toHaveBeenCalled();
    await query('UPDATE messages SET body_last_opened_at=clock_timestamp() WHERE id=$1',[id]);
    await prefetchVisibleBodies({id:account,user_id:user,mail_transport:'imap_smtp'},[id],read);expect(read).toHaveBeenCalledTimes(1);
    expect((await query('SELECT body_text,body_cache_evicted_at FROM messages WHERE id=$1',[id])).rows[0]).toEqual({body_text:'Fetched',body_cache_evicted_at:null});
  });
  it('preserves drafts, unbound local copies, disabled accounts and pending actions',async()=>{
    const draft=await message(),local=await message(),pending=await message();
    await query("UPDATE messages SET flags=jsonb_build_array(chr(92)||'Draft') WHERE id=$1",[draft]);
    await query('UPDATE messages SET uid=0 WHERE id=$1',[local]);
    const rule=randomUUID();await query("INSERT INTO inbox_rules(id,user_id,name,conditions,actions) VALUES($1,$2,'test','[]','[]')",[rule,user]);
    await query("INSERT INTO inbox_rule_forwards(rule_id,message_id,status) VALUES($1,$2,'pending')",[rule,pending]);
    expect((await expire()).evicted).toBe(0);
    await message();await query('UPDATE email_accounts SET enabled=false WHERE id=$1',[account]);expect((await expire()).evicted).toBe(0);
  });
  it('keeps native provider caches without a live provider binding',async()=>{
    await message();await query("UPDATE email_accounts SET mail_transport='gmail_api' WHERE id=$1",[account]);expect((await expire()).evicted).toBe(0);
    await query("UPDATE email_accounts SET mail_transport='microsoft_graph' WHERE id=$1",[account]);expect((await expire()).evicted).toBe(0);
  });
  it('skips a row being opened and respects its refreshed access timestamp after commit',async()=>{
    const id=await message(),guard=await pool.connect();
    try{
      await guard.query('BEGIN');await guard.query('UPDATE messages SET body_last_opened_at=clock_timestamp() WHERE id=$1',[id]);
      expect((await expire()).evicted).toBe(0);await guard.query('COMMIT');
      expect((await expire()).evicted).toBe(0);
    }finally{await guard.query('ROLLBACK');guard.release();}
  });
  it('bounds each sweep and tracks new cache fills without changing dates on no-op writes',async()=>{
    for(let n=0;n<BODY_CACHE_RETENTION_BATCH+2;n++)await message();
    expect((await expire()).evicted).toBe(BODY_CACHE_RETENTION_BATCH);expect((await expire()).evicted).toBe(2);
    const id=await message(),before=(await query('SELECT body_cache_refreshed_at FROM messages WHERE id=$1',[id])).rows[0].body_cache_refreshed_at;
    await query('UPDATE messages SET body_text=body_text WHERE id=$1',[id]);
    expect((await query('SELECT body_cache_refreshed_at FROM messages WHERE id=$1',[id])).rows[0].body_cache_refreshed_at).toEqual(before);
    await query("UPDATE messages SET body_text='New fetch' WHERE id=$1",[id]);
    expect((await expire()).evicted).toBe(0);
  });
  it.each(['gmail_api','microsoft_graph'])('expires %s cache with verified provider identity and resets body completeness',async transport=>{
    const pc=randomUUID();await query("INSERT INTO provider_connections(id,user_id,provider) VALUES($1,$2,$3)",[pc,user,transport==='gmail_api'?'google':'microsoft']);
    await query('UPDATE email_accounts SET mail_transport=$2,provider_connection_id=$3 WHERE id=$1',[account,transport,pc]);
    const id=await message();await query("UPDATE messages SET provider_message_id='remote-id',gmail_rule_body_complete=true,gmail_reader_body_complete=true,graph_reader_body_complete=true WHERE id=$1",[id]);
    expect((await expire()).evicted).toBe(1);
    const row=(await query('SELECT id,provider_message_id,body_text,gmail_rule_body_complete,gmail_reader_body_complete,graph_reader_body_complete FROM messages WHERE id=$1',[id])).rows[0];
    expect(row).toEqual({id,provider_message_id:'remote-id',body_text:null,gmail_rule_body_complete:false,gmail_reader_body_complete:false,graph_reader_body_complete:false});
    const preserved=await message();await query("UPDATE messages SET provider_message_id='other' WHERE id=$1",[preserved]);
    await query("UPDATE provider_connections SET status='revoked' WHERE id=$1",[pc]);expect((await expire()).evicted).toBe(0);
  });

});
