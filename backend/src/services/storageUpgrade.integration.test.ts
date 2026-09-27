import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, pool } from './db.js';
import { runMigrations } from './migrations.js';
import { readDavSyncSnapshot } from './davSyncSnapshot.js';
import { readStorageMaintenanceStatus, startStorageMaintenance, stopStorageMaintenance } from './storageMaintenance.js';
const enabled = process.env.STORAGE_UPGRADE_GATE === '1';
if (enabled && (!process.env.DB_HOST || !process.env.DB_NAME)) throw new Error('Storage upgrade requires its own empty PostgreSQL database');
describe.skipIf(!enabled)('populated 4.1.1 automatic background upgrade', () => {
  afterAll(async()=>{await stopStorageMaintenance();await pool.end();});
  it('cuts over tokens, repairs headers, releases retired files and resumes across restart without changing canonical data',async()=>{
    await runMigrations({upTo:'0145'});
    const user=randomUUID(), calendar=randomUUID(), book=randomUUID(), event=randomUUID(), contact=randomUUID(), account=randomUUID();
    const raw='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:upgrade\r\nDTSTART:20260927T090000Z\r\nSUMMARY:Preserved event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const vcard='BEGIN:VCARD\r\nVERSION:3.0\r\nUID:upgrade\r\nFN:Preserved contact\r\nEND:VCARD\r\n';
    const headers='Subject: Original\r\nMessage-ID: <upgrade@test>\r\n';
    const expanded=[...Buffer.from(headers).entries()].map(([i,b])=>`${i}: ${b}`).join('\r\n');
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,'storage-upgrade','unused')",[user]);
    await query("INSERT INTO calendars(id,user_id,owner_user_id,name) VALUES($1,$2,$2,'Preserved')",[calendar,user]);
    await query("INSERT INTO address_books(id,user_id,name,source) VALUES($1,$2,'Preserved','local')",[book,user]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,enabled) VALUES($1,$2,'Preserved','upgrade@example.test','imap',false)",[account,user]);
    await query("INSERT INTO calendar_events(id,calendar_id,user_id,uid,raw_ical,etag,starts_at,ends_at) VALUES($1,$2,$3,'upgrade',$4,'stable','2026-09-27T09:00:00Z','2026-09-27T10:00:00Z')",[event,calendar,user,raw]);
    await query("INSERT INTO contacts(id,address_book_id,user_id,uid,vcard,etag) VALUES($1,$2,$3,'upgrade',$4,'stable')",[contact,book,user,vcard]);
    // Reproduce repeated unchanged source updates by populating the old append-only journal.
    await query(`INSERT INTO calendar_sync_changes(calendar_id,uid,version,etag,deleted,raw_ical)
      SELECT $1,'upgrade',n,'stable',false,$2||md5(n::text) FROM generate_series(2,50000) n`,[calendar,raw]);
    await query(`INSERT INTO contact_sync_changes(address_book_id,filename,version,etag,deleted,vcard)
      SELECT $1,'upgrade.vcf',n,'stable',false,$2||md5(n::text) FROM generate_series(2,5000) n`,[book,vcard]);
    await query("UPDATE calendars SET sync_version=50000,sync_token='sync-50000' WHERE id=$1",[calendar]);
    await query('UPDATE address_books SET sync_version=5000 WHERE id=$1',[book]);
    await query(`INSERT INTO messages(account_id,uid,folder,message_id,conversation_raw_headers,body_text)
      SELECT $1,n,'INBOX','<upgrade-'||n||'@test>',$2,'Preserved body' FROM generate_series(1,121) n`,[account,expanded]);
    const canonical=async()=>({
      events:(await query('SELECT id,raw_ical,etag FROM calendar_events WHERE user_id=$1 ORDER BY id',[user])).rows,
      contacts:(await query('SELECT id,vcard,etag FROM contacts WHERE user_id=$1 ORDER BY id',[user])).rows,
      messages:(await query('SELECT id,body_text,message_id FROM messages WHERE account_id=$1 ORDER BY id',[account])).rows,
    });
    const before=await canonical();
    const oldSize=Number((await query("SELECT pg_total_relation_size('calendar_sync_changes')+pg_total_relation_size('contact_sync_changes') AS size")).rows[0].size);
    await runMigrations();await runMigrations();
    expect(await canonical()).toEqual(before);
    expect((await readDavSyncSnapshot('calendar',calendar,user,50000)).status).toBe('expired');
    expect((await readDavSyncSnapshot('contacts',book,user,5000)).status).toBe('expired');
    expect((await readDavSyncSnapshot('calendar',calendar,user,null)).resources[0].raw_ical).toBe(raw);
    expect((await readDavSyncSnapshot('contacts',book,user,null)).resources[0].vcard).toBe(vcard);
    // Use the startup scheduler, not a manual repair entry point. Stop after one
    // batch, then restart and verify durable progress survives the interruption.
    startStorageMaintenance({NODE_ENV:'production'});
    let firstRepaired=0;
    const firstDeadline=Date.now()+20000;
    while(Date.now()<firstDeadline){
      const row=(await query<{progress:{repaired?:number}}>('SELECT progress FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0];
      firstRepaired=row?.progress.repaired ?? 0;
      if(firstRepaired>0)break;
      await new Promise(r=>setTimeout(r,50));
    }
    await stopStorageMaintenance();expect(firstRepaired).toBeGreaterThan(0);expect(firstRepaired).toBeLessThan(121);
    const afterPause=await canonical();expect(afterPause).toEqual(before);
    startStorageMaintenance({NODE_ENV:'production'});
    const deadline=Date.now()+25000;let complete=false;
    while(Date.now()<deadline){
      const row=(await query<{completed_at:string|null}>("SELECT completed_at FROM storage_maintenance WHERE task='baseline'")).rows[0];
      if(row?.completed_at){complete=true;break;}
      await new Promise(r=>setTimeout(r,100));
    }
    await stopStorageMaintenance();expect(complete).toBe(true);
    expect(await canonical()).toEqual(before);
    const payloads=await query<{count:number;exact:number}>("SELECT COUNT(*)::int AS count,COUNT(*) FILTER(WHERE conversation_raw_headers=$2)::int AS exact FROM messages WHERE account_id=$1",[account,headers]);
    expect(payloads.rows[0]).toEqual({count:121,exact:121});
    const progress=(await query<{progress:{repaired:number;logical_bytes_saved:number}}>('SELECT progress FROM storage_maintenance WHERE task=$1',[`headers:${account}`])).rows[0].progress;
    expect(progress.repaired).toBe(121);expect(progress.logical_bytes_saved).toBe(121*(Buffer.byteLength(expanded)-Buffer.byteLength(headers)));
    const retiredSize=Number((await query("SELECT pg_total_relation_size('calendar_sync_changes_legacy_0146')+pg_total_relation_size('contact_sync_changes_legacy_0146') AS size")).rows[0].size);
    expect(retiredSize).toBeLessThan(oldSize/10);
    console.info('storage upgrade measured bytes',JSON.stringify({retired_before:oldSize,retired_after:retiredSize,status:await readStorageMaintenanceStatus()}));
  },60000);
});
