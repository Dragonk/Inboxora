import {randomUUID} from 'node:crypto';
import express from 'express';
import type {Server} from 'node:http';
import {beforeAll,beforeEach,afterAll,afterEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../index.js',()=>({imapManager:{fetchMessageBody:mocks.read,noteUserActivity:vi.fn(),broadcast:vi.fn(),pluginFacade:{}}}));
import {query,pool} from '../services/db.js';
import {expireMailBodyCache} from '../services/mailBodyCacheRetention.js';
import {mockSession} from '../test/http.js';
import {listeningPort} from '../test/net.js';
import mailRoutes from './mail.js';
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_NAME);
if(process.env.REQUIRE_STORAGE_POSTGRES==='1'&&!enabled)throw new Error('Cache route tests require PostgreSQL');
describe.skipIf(!enabled)('foreground message access and cache eviction',()=>{
  let server:Server,base:string,user:string,other:string,account:string,id:string;
  beforeAll(async()=>{
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{const userId=req.get('x-test-user');if(userId)req.session=mockSession({userId});next();});
    app.use('/api/mail',mailRoutes);
    await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',()=>resolve());});base=`http://127.0.0.1:${listeningPort(server)}`;
  });
  beforeEach(async()=>{
    user=randomUUID();other=randomUUID();account=randomUUID();id=randomUUID();mocks.read.mockReset();
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test'),($3,$4,'test')",[user,`route-${user}`,other,`other-${other}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport) VALUES($1,$2,'Cache','cache@example.test','imap','imap_smtp')",[account,user]);
    await query("INSERT INTO folders(account_id,path,name,uid_validity) VALUES($1,'INBOX','INBOX',1)",[account]);
    await query("INSERT INTO messages(id,account_id,uid,folder,body_text,subject,snippet) VALUES($1,$2,42,'INBOX','Cached text','Subject','Keep snippet')",[id,account]);
    await query("UPDATE messages SET body_cache_refreshed_at=NOW()-INTERVAL '40 days' WHERE id=$1",[id]);
  });
  afterEach(async()=>{await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[user,other]]);});
  afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pool.end();});
  const get=(u=user)=>fetch(`${base}/api/mail/messages/${id}/body`,{headers:{'x-test-user':u}});
  async function expire(){const c=await pool.connect();try{return await expireMailBodyCache(c);}finally{c.release();}}
  it('renews expiry for a cached body without changing read state or fetching the provider',async()=>{
    const response=await get();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({text:'Cached text'});
    expect(mocks.read).not.toHaveBeenCalled();expect((await expire()).evicted).toBe(0);
    expect((await query('SELECT body_last_opened_at IS NOT NULL AS opened,is_read FROM messages WHERE id=$1',[id])).rows[0]).toEqual({opened:true,is_read:false});
  });
  it('refetches an expired body through IMAP when the user opens the preserved message',async()=>{
    expect((await expire()).evicted).toBe(1);mocks.read.mockResolvedValue({text:'Refetched text',html:null,attachments:[]});
    const response=await get();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({text:'Refetched text'});
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect((await query('SELECT id,body_text,body_cache_evicted_at,body_last_opened_at IS NOT NULL AS opened FROM messages WHERE id=$1',[id])).rows[0])
      .toEqual({id,body_text:'Refetched text',body_cache_evicted_at:null,opened:true});
  });
  it('allows owned browser-memory touches but rejects another owner and anonymous callers',async()=>{
    expect((await get(other)).status).toBe(404);
    expect((await query('SELECT body_last_opened_at FROM messages WHERE id=$1',[id])).rows[0].body_last_opened_at).toBeNull();
    expect((await fetch(`${base}/api/mail/messages/${id}/body-access`,{method:'POST'})).status).toBe(401);
    expect((await fetch(`${base}/api/mail/messages/${id}/body-access`,{method:'POST',headers:{'x-test-user':other}})).status).toBe(404);
    expect((await fetch(`${base}/api/mail/messages/${id}/body-access`,{method:'POST',headers:{'x-test-user':user}})).status).toBe(200);
    expect((await expire()).evicted).toBe(0);expect(mocks.read).not.toHaveBeenCalled();
  });
});
