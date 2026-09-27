import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query } from './db.js';
import { DAV_MAX_CHANGES, pruneDavJournal, pruneOperationalHistory, releaseRetiredDavJournals, runStorageMaintenancePass, runOperationalRetentionPass } from './storageMaintenance.js';
import { conversationSerializeKey } from './conversationPersistence.js';
import { readDavSyncSnapshot } from './davSyncSnapshot.js';
const enabled = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (process.env.REQUIRE_STORAGE_POSTGRES === '1' && !enabled) throw new Error('Storage regressions require PostgreSQL');
const raw = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:storage-event\r\nDTSTART:20260927T090000Z\r\nSUMMARY:Original\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:storage-contact\r\nFN:Original\r\nEND:VCARD\r\n';
describe.skipIf(!enabled)('automatic storage maintenance with real PostgreSQL', () => {
  let user: string, calendar: string, book: string, event: string, contact: string, account: string;
  beforeEach(async () => {
    user=randomUUID(); calendar=randomUUID(); book=randomUUID(); event=randomUUID(); contact=randomUUID(); account=randomUUID();
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'test-only')",[user,`storage-${user}`]);
    await query("INSERT INTO calendars(id,user_id,owner_user_id,name) VALUES($1,$2,$2,'Storage')",[calendar,user]);
    await query("INSERT INTO address_books(id,user_id,name,source) VALUES($1,$2,'Storage','local')",[book,user]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol) VALUES($1,$2,'Storage','storage@example.test','imap')",[account,user]);
    await query("INSERT INTO calendar_events(id,calendar_id,user_id,uid,raw_ical,etag,starts_at,ends_at) VALUES($1,$2,$3,'storage-event',$4,'v1','2026-09-27T09:00:00Z','2026-09-27T10:00:00Z')",[event,calendar,user,raw]);
    await query("INSERT INTO contacts(id,address_book_id,user_id,uid,vcard,etag) VALUES($1,$2,$3,'storage-contact',$4,'v1')",[contact,book,user,card]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await query('DELETE FROM users WHERE id=$1',[user]);
    await query("DELETE FROM storage_maintenance WHERE task LIKE '%'||$1 OR task LIKE '%'||$2 OR task LIKE '%'||$3",[calendar,book,account]);
  });
  afterAll(async () => { await pool.end(); });
  for (const kind of ['calendar','contacts'] as const) {
    it(`${kind}: no-op writes preserve versions and repeated changes keep one metadata row`, async () => {
      const cal=kind==='calendar', table=cal?'calendar_events':'contacts', journal=cal?'calendar_sync_changes':'contact_sync_changes';
      const parent=cal?'calendars':'address_books', scope=cal?'calendar_id':'address_book_id', id=cal?calendar:book;
      const resource=cal?event:contact, payload=cal?'raw_ical':'vcard';
      await query(`UPDATE ${table} SET updated_at=NOW(), ${payload}=${payload} WHERE id=$1`,[resource]);
      expect((await query<{v:string}>(`SELECT sync_version::text AS v FROM ${parent} WHERE id=$1`,[id])).rows[0].v).toBe('1');
      for(let n=0;n<10;n++) await query(`UPDATE ${table} SET etag=$2, ${payload}=$3 WHERE id=$1`,[resource,`v${n+2}`,(cal?raw:card).replace('Original',`Edit ${n}`)]);
      expect((await query(`SELECT COUNT(*)::int AS count,COUNT(${payload})::int AS payloads FROM ${journal} WHERE ${scope}=$1`,[id])).rows[0]).toEqual({count:1,payloads:0});
      const snapshot=await readDavSyncSnapshot(kind,id,user,1);
      expect(snapshot.status).toBe('ok'); expect(snapshot.resources).toHaveLength(1);
      expect(snapshot.resources[0][payload]).toContain('Edit 9'); expect(snapshot.resources[0].etag).toBe('v11');
      expect((await readDavSyncSnapshot(kind,id,randomUUID(),null)).status).toBe('missing');
    });
    it(`${kind}: rename/deletion and expired-token full sync retain DAV semantics`, async () => {
      const cal=kind==='calendar', id=cal?calendar:book, table=cal?'calendar_events':'contacts';
      const journal=cal?'calendar_sync_changes':'contact_sync_changes', scope=cal?'calendar_id':'address_book_id', resource=cal?event:contact;
      await query(`UPDATE ${table} SET dav_filename='renamed' WHERE id=$1`,[resource]);
      const delta=await readDavSyncSnapshot(kind,id,user,1);
      expect(delta.status).toBe('ok'); expect(delta.resources).toHaveLength(2);
      expect(delta.resources.find(r=>r.dav_filename==='renamed')?.deleted).toBe(false);
      expect(delta.resources.filter(r=>r.deleted)).toHaveLength(1);
      await query(`UPDATE ${journal} SET created_at=NOW()-INTERVAL '31 days' WHERE ${scope}=$1`,[id]);
      const client=await pool.connect();try{expect(await pruneDavJournal(client,kind,id)).toBe(2);}finally{client.release();}
      expect((await readDavSyncSnapshot(kind,id,user,1)).status).toBe('expired');
      const full=await readDavSyncSnapshot(kind,id,user,null);
      expect(full.status).toBe('ok'); expect(full.resources).toHaveLength(1); expect(full.resources[0].dav_filename).toBe('renamed');
      await query(`DELETE FROM ${table} WHERE id=$1`,[resource]);
      const version=Number(full.token.split(':').at(-1)?.replace('sync-',''));
      expect((await readDavSyncSnapshot(kind,id,user,version)).resources[0].deleted).toBe(true);
    });
  }
  it('caps bursts and advances exactly the pruned floor without touching events', async()=>{
    await query(`INSERT INTO calendar_sync_changes(calendar_id,uid,dav_filename,version,deleted)
      SELECT $1,'removed-'||n,'removed-'||n||'.ics',n,true FROM generate_series(2,$2) n`,[calendar,DAV_MAX_CHANGES+10]);
    await query('UPDATE calendars SET sync_version=$2 WHERE id=$1',[calendar,DAV_MAX_CHANGES+10]);
    const client=await pool.connect();try{expect(await pruneDavJournal(client,'calendar',calendar)).toBe(10);}finally{client.release();}
    expect((await readDavSyncSnapshot('calendar',calendar,user,9)).status).toBe('expired');
    expect((await readDavSyncSnapshot('calendar',calendar,user,10)).status).toBe('ok');
    expect((await query('SELECT id FROM calendar_events WHERE id=$1',[event])).rows).toHaveLength(1);
  });
  it('releases retired table files automatically while preserving canonical data',async()=>{
    await query("DELETE FROM storage_maintenance WHERE task LIKE 'retired:%'");
    await query(`INSERT INTO calendar_sync_changes_legacy_0146(calendar_id,uid,version,raw_ical)
      SELECT $1,'legacy-'||n,n,repeat(md5(n::text),128) FROM generate_series(1,1000) n`,[calendar]);
    const client=await pool.connect();try{
      expect(await releaseRetiredDavJournals(client)).toBeGreaterThan(32768);
      expect(await releaseRetiredDavJournals(client)).toBe(0);
    }finally{client.release();}
    expect((await query('SELECT raw_ical FROM calendar_events WHERE id=$1',[event])).rows[0].raw_ical).toBe(raw);
    expect((await query('SELECT vcard FROM contacts WHERE id=$1',[contact])).rows[0].vcard).toBe(card);
  });
  it('retired journal lock contention rolls back and can be retried',async()=>{
    await query("DELETE FROM storage_maintenance WHERE task='retired:calendar_sync_changes_legacy_0146'");
    const guard=await pool.connect(),worker=await pool.connect();
    try{
      await guard.query('BEGIN');await guard.query('SELECT 1 FROM calendar_sync_changes_legacy_0146 LIMIT 1');
      vi.spyOn(console,'warn').mockImplementation(()=>{});
      await releaseRetiredDavJournals(worker);
      const deferred = await query<{progress:{last_error_code:string};deferred:boolean}>("SELECT progress,next_run_at>NOW() AS deferred FROM storage_maintenance WHERE task='retired:calendar_sync_changes_legacy_0146'");
      expect(deferred.rows[0]).toMatchObject({progress:{last_error_code:'55P03'},deferred:true});
      await guard.query('COMMIT');
      await query("UPDATE storage_maintenance SET next_run_at=NOW() WHERE task='retired:calendar_sync_changes_legacy_0146'");
      await releaseRetiredDavJournals(worker);
      expect((await query("SELECT completed_at FROM storage_maintenance WHERE task='retired:calendar_sync_changes_legacy_0146'")).rows[0].completed_at).not.toBeNull();
    }finally{await guard.query('ROLLBACK');guard.release();worker.release();}
  });
  it('repairs headers automatically without double-counting concurrent workers',async()=>{
    const text='Message-ID: <storage@test>\r\nSubject: Original\r\n';
    const expanded=[...Buffer.from(text).entries()].map(([i,b])=>`${i}: ${b}`).join('\r\n'),id=randomUUID();
    await query("INSERT INTO messages(id,account_id,uid,folder,conversation_raw_headers) VALUES($1,$2,1,'INBOX',$3)",[id,account,expanded]);
    await query(`INSERT INTO storage_maintenance(task,next_run_at) SELECT 'headers:'||id::text,NOW()+INTERVAL '1 day' FROM email_accounts WHERE id<>$1 ON CONFLICT(task) DO UPDATE SET next_run_at=EXCLUDED.next_run_at`,[account]);
    await Promise.all([runStorageMaintenancePass(),runStorageMaintenancePass()]);
    expect((await query('SELECT conversation_raw_headers FROM messages WHERE id=$1',[id])).rows[0].conversation_raw_headers).toBe(text);
    const state=(await query('SELECT progress FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0].progress;
    expect(state).toMatchObject({repaired:1,logical_bytes_saved:Buffer.byteLength(expanded)-Buffer.byteLength(text)});
    await runStorageMaintenancePass();expect((await query('SELECT progress FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0].progress).toEqual(state);
  });
  it('preserves pending work and completed delivery deduplication keys',async()=>{
    await query(`INSERT INTO domain_outbox(user_id,topic,dedupe_key,payload,status,updated_at)
      VALUES($1,'test','done','{"large":"payload"}','done',NOW()-INTERVAL '8 days'),
            ($1,'test','pending','{"large":"payload"}','pending',NOW()-INTERVAL '8 days')`,[user]);
    const client=await pool.connect();try{await pruneOperationalHistory(client);}finally{client.release();}
    expect((await query('SELECT dedupe_key,payload FROM domain_outbox WHERE user_id=$1 ORDER BY dedupe_key',[user])).rows)
      .toEqual([{dedupe_key:'done',payload:{}},{dedupe_key:'pending',payload:{large:'payload'}}]);
  });
  it('does not report a completed sweep while a busy account is waiting for its lock',async()=>{
    await query(`INSERT INTO storage_maintenance(task,next_run_at,completed_at)
      SELECT 'headers:'||id::text,NOW()+INTERVAL '1 day',NOW() FROM email_accounts WHERE id<>$1
      ON CONFLICT(task) DO UPDATE SET next_run_at=EXCLUDED.next_run_at,completed_at=EXCLUDED.completed_at`,[account]);
    await query("UPDATE storage_maintenance SET completed_at=NULL WHERE task='baseline'");
    const guard=await pool.connect(),key=conversationSerializeKey(user,account);
    try{
      await guard.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))',[key,key+':2']);
      await runStorageMaintenancePass();
      await runStorageMaintenancePass();
      expect((await query("SELECT completed_at FROM storage_maintenance WHERE task='baseline'")).rows[0].completed_at).toBeNull();
      expect((await query('SELECT completed_at FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0].completed_at).toBeNull();
    }finally{await guard.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[key,key+':2']);guard.release();}
    await query('UPDATE storage_maintenance SET next_run_at=NOW() WHERE task=$1',[`headers:${account}`]);
    await runStorageMaintenancePass();
    expect((await query('SELECT completed_at FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0].completed_at).not.toBeNull();
  });

  it('backs off a locked header row while operational retention continues',async()=>{
    const rawHeader='Subject: Locked row\r\n';
    const encoded=[...Buffer.from(rawHeader).entries()].map(([i,b])=>`${i}: ${b}`).join('\r\n');
    const id=randomUUID();
    await query("INSERT INTO messages(id,account_id,uid,folder,conversation_raw_headers) VALUES($1,$2,99,'INBOX',$3)",[id,account,encoded]);
    await query(`INSERT INTO storage_maintenance(task,next_run_at) SELECT 'headers:'||id::text,NOW()+INTERVAL '1 day' FROM email_accounts WHERE id<>$1 ON CONFLICT(task) DO UPDATE SET next_run_at=EXCLUDED.next_run_at`,[account]);
    await query("INSERT INTO auth_events(event_type,user_id,success,created_at) VALUES('login',$1,false,NOW()-INTERVAL '91 days')",[user]);
    await query("DELETE FROM storage_maintenance WHERE task='logs'");
    const guard=await pool.connect();
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{
      await guard.query('BEGIN');await guard.query('SELECT id FROM messages WHERE id=$1 FOR UPDATE',[id]);
      await runStorageMaintenancePass();
      const state=(await query("SELECT progress,next_run_at>NOW() AS deferred FROM storage_maintenance WHERE task=$1",[`headers:${account}`])).rows[0];
      expect(state).toMatchObject({progress:{last_error_code:'55P03'},deferred:true});
      expect((await query('SELECT id FROM auth_events WHERE user_id=$1',[user])).rows).toHaveLength(0);
      expect((await query('SELECT conversation_raw_headers FROM messages WHERE id=$1',[id])).rows[0].conversation_raw_headers).toBe(encoded);
    }finally{await guard.query('ROLLBACK');guard.release();}
    await query('UPDATE storage_maintenance SET next_run_at=NOW() WHERE task=$1',[`headers:${account}`]);
    await runStorageMaintenancePass();
    expect((await query('SELECT conversation_raw_headers FROM messages WHERE id=$1',[id])).rows[0].conversation_raw_headers).toBe(rawHeader);
  });
  it('privacy-log-only maintenance does not run data repairs',async()=>{
    await query("INSERT INTO auth_events(event_type,user_id,success,created_at) VALUES('login',$1,false,NOW()-INTERVAL '91 days')",[user]);
    await query("DELETE FROM storage_maintenance WHERE task='logs'");
    await runOperationalRetentionPass();
    expect((await query('SELECT id FROM auth_events WHERE user_id=$1',[user])).rows).toHaveLength(0);
    expect((await query('SELECT task FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows).toHaveLength(0);
  });
  it('reads full DAV resources as separate snapshot rows, including an empty collection',async()=>{
    expect(readFileSync(new URL('./davSyncSnapshot.ts',import.meta.url),'utf8')).not.toMatch(/jsonb_agg/);
    await query('DELETE FROM contacts WHERE id=$1',[contact]);
    const empty=await readDavSyncSnapshot('contacts',book,user,null);
    expect(empty.status).toBe('ok');expect(empty.resources).toEqual([]);
    await query(`INSERT INTO contacts(address_book_id,user_id,uid,vcard,etag)
      SELECT $1,$2,'large-'||n,'BEGIN:VCARD\r\nPHOTO:'||repeat('a',100000)||'\r\nEND:VCARD','stable'
      FROM generate_series(1,100) n`,[book,user]);
    const full=await readDavSyncSnapshot('contacts',book,user,null);
    expect(full.status).toBe('ok');expect(full.resources).toHaveLength(100);
    expect(full.resources.every(r=>(r.vcard?.length ?? 0)>100000)).toBe(true);
  });

});
