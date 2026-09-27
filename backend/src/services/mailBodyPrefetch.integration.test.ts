import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query } from './db.js';
import { MAX_PREFETCH_CACHE_BYTES, prefetchVisibleBodies, type PrefetchMessage } from './mailBodyPrefetch.js';
const enabled = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (process.env.REQUIRE_STORAGE_POSTGRES === '1' && !enabled) throw new Error('Prefetch regressions require PostgreSQL');
describe.skipIf(!enabled)('visible mail body prefetch with real PostgreSQL', () => {
  let user: string, accountId: string, otherId: string;
  const account = () => ({ id:accountId, user_id:user, mail_transport:'imap_smtp' });
  let uid: number;
  async function message(a=accountId) {
    const id=randomUUID();
    await query("INSERT INTO messages(id,account_id,uid,folder,subject) VALUES($1,$2,$3,'INBOX','Visible')",[id,a,uid++]);
    return id;
  }
  beforeEach(async()=>{
    user=randomUUID();accountId=randomUUID();otherId=randomUUID();uid=1;
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`prefetch-${user}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport) VALUES($1,$3,'A','a@example.test','imap','imap_smtp'),($2,$3,'B','b@example.test','imap','imap_smtp')",[accountId,otherId,user]);
  });
  afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await query('DELETE FROM users WHERE id=$1',[user]);});
  afterAll(async()=>{await pool.end();});
  it('warms at most three visible owned messages, leaves history untouched and reuses the cache',async()=>{
    const ids=[];for(let n=0;n<6;n++)ids.push(await message());
    const reader=vi.fn(async (_m: PrefetchMessage)=>({html:null,text:'Warmed',attachments:[]}));
    await prefetchVisibleBodies(account(),ids,reader);
    expect(reader).toHaveBeenCalledTimes(3);
    const rows=await query<{id:string;body_text:string|null}>('SELECT id,body_text FROM messages WHERE account_id=$1',[accountId]);
    expect(rows.rows.filter(r=>r.body_text==='Warmed').map(r=>r.id).sort()).toEqual(ids.slice(0,3).sort());
    await prefetchVisibleBodies(account(),ids,reader);expect(reader).toHaveBeenCalledTimes(3);
    const foreign=await message(otherId);
    await prefetchVisibleBodies(account(),[foreign],reader);
    await prefetchVisibleBodies({...account(),user_id:randomUUID()},[ids[3]],reader);
    expect(reader).toHaveBeenCalledTimes(3);
  });
  it('cannot overwrite a foreground read or a row changed during the network request',async()=>{
    const first=await message(),second=await message();
    await prefetchVisibleBodies(account(),[first,second],async m=>{
      if(m.id===first)await query("UPDATE messages SET body_text='Foreground' WHERE id=$1",[first]);
      else await query('UPDATE messages SET row_version=row_version+1 WHERE id=$1',[second]);
      return {html:null,text:'Late'};
    });
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[first])).rows[0].body_text).toBe('Foreground');
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[second])).rows[0].body_text).toBeNull();
  });
  it('discards the result after account disable and honors account cooldown after a failure',async()=>{
    const id=await message();
    await prefetchVisibleBodies(account(),[id],async()=>{
      await query('UPDATE email_accounts SET enabled=false WHERE id=$1',[accountId]);
      return {html:null,text:'Late'};
    });
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[id])).rows[0].body_text).toBeNull();
    await query('UPDATE email_accounts SET enabled=true WHERE id=$1',[accountId]);
    const ids=[await message(),await message()];
    const error=Object.assign(new Error('rate limit'),{code:'RATE_LIMITED',retryAfterSeconds:7200});
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const reader=vi.fn(async()=>{throw error;});
    await prefetchVisibleBodies(account(),ids,reader);expect(reader).toHaveBeenCalledTimes(1);
    await prefetchVisibleBodies(account(),[await message()],reader);expect(reader).toHaveBeenCalledTimes(1);
    const delay=await query<{s:number}>('SELECT EXTRACT(EPOCH FROM body_prefetch_after-NOW())::int AS s FROM email_accounts WHERE id=$1',[accountId]);
    expect(delay.rows[0].s).toBeGreaterThan(7100);
  });
  it('does not cache an oversized body or retry it on every refresh',async()=>{
    const id=await message();
    const reader=vi.fn(async()=>({html:null,text:'x'.repeat(MAX_PREFETCH_CACHE_BYTES+1)}));
    await prefetchVisibleBodies(account(),[id],reader);await prefetchVisibleBodies(account(),[id],reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[id])).rows[0].body_text).toBeNull();
  });
  it('single-flights overlapping requests and supports an explicit off switch',async()=>{
    const id=await message();let finish:()=>void=()=>{};let started:()=>void=()=>{};
    const start=new Promise<void>(resolve=>{started=resolve;});
    const wait=new Promise<void>(resolve=>{finish=resolve;});
    const reader=vi.fn(async()=>{started();await wait;return{html:null,text:'Warmed'};});
    const flight=prefetchVisibleBodies(account(),[id],reader);await start;
    try{await prefetchVisibleBodies(account(),[id],reader);expect(reader).toHaveBeenCalledTimes(1);}finally{finish();await flight;}
    vi.stubEnv('MAIL_BODY_PREFETCH','off');await prefetchVisibleBodies(account(),[await message()],reader);expect(reader).toHaveBeenCalledTimes(1);
  });
  it('does not replace IMAP attachment metadata with an empty speculative body',async()=>{
    const id=await message();
    const known=[{part:'1',filename:'kept.pdf',size:12}];
    await query('UPDATE messages SET attachments=$2::jsonb WHERE id=$1',[id,JSON.stringify(known)]);
    await prefetchVisibleBodies(account(),[id],async()=>({html:null,text:'',attachments:[]}));
    expect((await query('SELECT body_text,body_html,attachments FROM messages WHERE id=$1',[id])).rows[0])
      .toEqual({body_text:null,body_html:null,attachments:known});
  });

});
