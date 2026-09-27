import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import express from 'express';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../index.js',()=>({imapManager:{disconnectUser:vi.fn()}}));
import adminRouter from './admin.js';
import {query,pool} from '../services/db.js';
import {RETENTION_KEYS} from '../services/storageRetentionSettings.js';
import {readMailPrefetchLimit} from '../services/mailPrefetchSettings.js';
import {mockSession} from '../test/http.js';
import {listeningPort} from '../test/net.js';
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_NAME);
if(process.env.REQUIRE_STORAGE_POSTGRES==='1'&&!enabled)throw new Error('Admin prefetch tests require PostgreSQL');
describe.skipIf(!enabled)('admin prefetch configuration with real authorization and PostgreSQL',()=>{
  let server:Server,base:string,admin:string,member:string;
  beforeAll(async()=>{
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{
      const userId=req.get('x-test-user');if(userId)req.session=mockSession({userId,username:'Test administrator',isAdmin:true});next();
    });
    app.use('/admin',adminRouter);
    await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',()=>resolve());});
    base=`http://127.0.0.1:${listeningPort(server)}`;
  });
  beforeEach(async()=>{
    admin=randomUUID();member=randomUUID();
    await query("INSERT INTO users(id,username,password_hash,is_admin) VALUES($1,$3,'unused',true),($2,$4,'unused',false)",[admin,member,`admin-${admin}`,`member-${member}`]);
    await query("DELETE FROM system_settings WHERE key='mail_body_prefetch_limit' OR key=ANY($1::text[])",[RETENTION_KEYS]);
  });
  afterEach(async()=>{vi.unstubAllEnvs();await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[admin,member]]);await query("DELETE FROM system_settings WHERE key='mail_body_prefetch_limit' OR key=ANY($1::text[])",[RETENTION_KEYS]);});
  afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));await pool.end();});
  const get=(user=admin)=>fetch(base+'/admin/settings',{headers:{'x-test-user':user}});
  const patch=(body:unknown,user=admin)=>fetch(base+'/admin/settings',{method:'PATCH',headers:{'x-test-user':user,'content-type':'application/json'},body:JSON.stringify(body)});
  it('returns a default of 25 and saves an administrator-selected 30 for the next backend batch',async()=>{
    const before=await get();expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({settings:{mail_body_prefetch_limit:'25'},mailPrefetch:{defaultLimit:25,maxLimit:100,disabledByEnvironment:false}});
    expect((await patch({mail_body_prefetch_limit:30})).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({settings:{mail_body_prefetch_limit:'30'}});
    expect(await readMailPrefetchLimit(pool)).toBe(30);
    expect((await patch({mail_body_prefetch_limit:0})).status).toBe(200);expect(await readMailPrefetchLimit(pool)).toBe(0);
    expect((await patch({mail_body_prefetch_limit:100})).status).toBe(200);expect(await readMailPrefetchLimit(pool)).toBe(100);
  });
  it('rejects unauthenticated users and members, and rechecks revoked administrator privileges',async()=>{
    expect((await fetch(base+'/admin/settings')).status).toBe(401);
    expect((await get(member)).status).toBe(403);expect((await patch({mail_body_prefetch_limit:30},member)).status).toBe(403);
    await query('UPDATE users SET is_admin=false WHERE id=$1',[admin]);
    expect((await patch({mail_body_prefetch_limit:30})).status).toBe(403);
    expect((await query("SELECT 1 FROM system_settings WHERE key='mail_body_prefetch_limit'")).rows).toHaveLength(0);
  });
  it.each([-1,101,25.5,'30oops','',null,true,[],{}])('rejects invalid limits before any mixed-patch write: %j',async value=>{
    const prior=(await query("SELECT value FROM system_settings WHERE key='custom_css'")).rows;
    const response=await patch({mail_body_prefetch_limit:value,custom_css:'body { margin: 0; }'});
    expect(response.status).toBe(400);expect(await response.json()).toMatchObject({code:'INVALID_PREFETCH_LIMIT'});
    expect((await query("SELECT value FROM system_settings WHERE key='custom_css'")).rows).toEqual(prior);
    expect((await query("SELECT 1 FROM system_settings WHERE key='mail_body_prefetch_limit'")).rows).toHaveLength(0);
  });
  it('preserves the configured value while exposing the environment override',async()=>{
    expect((await patch({mail_body_prefetch_limit:30})).status).toBe(200);vi.stubEnv('MAIL_BODY_PREFETCH','off');
    expect(await (await get()).json()).toMatchObject({settings:{mail_body_prefetch_limit:'30'},mailPrefetch:{disabledByEnvironment:true}});
    expect(await readMailPrefetchLimit(pool)).toBe(0);
  });
  it('saves global retention settings atomically and enforces live admin permissions',async()=>{
    const read=()=>fetch(base+'/admin/retention',{headers:{'x-test-user':admin}});
    const write=(body:unknown,user=admin)=>fetch(base+'/admin/retention',{method:'PATCH',headers:{'x-test-user':user,'content-type':'application/json'},body:JSON.stringify(body)});
    expect(await (await read()).json()).toMatchObject({values:{mail_body_cache_days:30,auth_log_days:90,dav_history_days:30}});
    expect((await write({mail_body_cache_days:7,auth_log_days:14})).status).toBe(200);
    expect(await (await read()).json()).toMatchObject({values:{mail_body_cache_days:7,auth_log_days:14}});
    expect((await write({mail_body_cache_days:30,auth_log_days:0})).status).toBe(400);
    expect(await (await read()).json()).toMatchObject({values:{mail_body_cache_days:7,auth_log_days:14}});
    expect((await write({mail_body_cache_days:0},member)).status).toBe(403);
    expect((await fetch(base+'/admin/retention')).status).toBe(401);
    expect((await write({mail_body_cache_days:0})).status).toBe(200);
    expect(await (await read()).json()).toMatchObject({values:{mail_body_cache_days:0}});
  });

});
