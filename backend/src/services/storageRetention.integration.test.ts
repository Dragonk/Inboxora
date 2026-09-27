import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,afterAll,describe,it,expect} from 'vitest';
import {pool,query} from './db.js';
import {pruneOperationalHistory,pruneDavJournal} from './storageMaintenance.js';
import {RETENTION_KEYS} from './storageRetentionSettings.js';
import {readDavSyncSnapshot} from './davSyncSnapshot.js';
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_NAME);
if(process.env.REQUIRE_STORAGE_POSTGRES==='1'&&!enabled)throw new Error('Retention policy regressions need PostgreSQL');
describe.skipIf(!enabled)('configured retention controls actual data cleanup',()=>{
  let user:string,calendar:string;
  beforeEach(async()=>{
    user=randomUUID();calendar=randomUUID();
    await query('DELETE FROM system_settings WHERE key=ANY($1::text[])',[RETENTION_KEYS]);
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test')",[user,`retention-${user}`]);
    await query("INSERT INTO calendars(id,user_id,owner_user_id,name) VALUES($1,$2,$2,'History')",[calendar,user]);
  });
  afterEach(async()=>{await query('DELETE FROM users WHERE id=$1',[user]);await query('DELETE FROM system_settings WHERE key=ANY($1::text[])',[RETENTION_KEYS]);});
  afterAll(async()=>{await pool.end();});
  async function set(key:string,value:number){await query('INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,String(value)]);}
  async function logs(){const c=await pool.connect();try{await pruneOperationalHistory(c);}finally{c.release();}}
  async function dav(){const c=await pool.connect();try{return await pruneDavJournal(c,'calendar',calendar);}finally{c.release();}}
  it('changes auth-log and completed-payload retention without deleting delivery identity',async()=>{
    await query("INSERT INTO auth_events(event_type,user_id,success,created_at) VALUES('login',$1,true,NOW()-INTERVAL '10 days'),('login',$1,true,NOW()-INTERVAL '40 days')",[user]);
    await set('auth_log_days',14);await logs();expect((await query('SELECT id FROM auth_events WHERE user_id=$1',[user])).rows).toHaveLength(1);
    await set('auth_log_days',1);await logs();expect((await query('SELECT id FROM auth_events WHERE user_id=$1',[user])).rows).toHaveLength(0);
    await query(`INSERT INTO domain_outbox(user_id,topic,dedupe_key,payload,status,updated_at)
      VALUES($1,'test','completed','{"a":1}','done',NOW()-INTERVAL '10 days'),($1,'test','pending','{"a":1}','pending',NOW()-INTERVAL '10 days')`,[user]);
    await set('completed_outbox_payload_days',30);await logs();expect((await query("SELECT payload FROM domain_outbox WHERE user_id=$1 AND dedupe_key='completed'",[user])).rows[0].payload).toEqual({a:1});
    await set('completed_outbox_payload_days',7);await logs();expect((await query('SELECT dedupe_key,payload FROM domain_outbox WHERE user_id=$1 ORDER BY dedupe_key',[user])).rows)
      .toEqual([{dedupe_key:'completed',payload:{}},{dedupe_key:'pending',payload:{a:1}}]);
  });
  it('uses both configured DAV age and count while preserving expired-token safety',async()=>{
    await query(`INSERT INTO calendar_sync_changes(calendar_id,uid,dav_filename,version,deleted,created_at)
      SELECT $1,'resource-'||n,'resource-'||n||'.ics',n,true,NOW()-INTERVAL '10 days' FROM generate_series(1,250) n`,[calendar]);
    await query('UPDATE calendars SET sync_version=250 WHERE id=$1',[calendar]);
    expect(await dav()).toBe(0);
    await set('dav_history_max_entries',100);expect(await dav()).toBe(150);
    expect((await readDavSyncSnapshot('calendar',calendar,user,149)).status).toBe('expired');
    expect((await readDavSyncSnapshot('calendar',calendar,user,150)).status).toBe('ok');
    await set('dav_history_days',7);expect(await dav()).toBe(100);
    expect((await readDavSyncSnapshot('calendar',calendar,user,150)).status).toBe('expired');
    expect((await query('SELECT id FROM calendars WHERE id=$1',[calendar])).rows).toHaveLength(1);
  });
});
