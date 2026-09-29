import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, withTransaction } from './db.js';
import { externalSourceFingerprint } from './providers/externalCollectionLinks.js';
import { decrypt, encrypt } from './encryption.js';
import { migrateDavAccounts, sameDavIdentity } from './davAccountMigration.js';
import { calendarPreferencePatch } from './calendarPreferencePatch.js';
import { withInvitationAlias } from './calendarInvitationSender.js';
import { acquireSyncLease, commitSyncCheckpoint, ensureSyncState, finishSyncRun, readSyncState, releaseSyncLease } from './syncCoordinator.js';
import { mailIndexDiagnostics } from './mailIndexDiagnostics.js';
import { getScheduledSummary } from './scheduledMail.js';

const discovery = vi.hoisted(() => vi.fn());
vi.mock('./davDiscovery.js', async original => ({ ...(await original<typeof import('./davDiscovery.js')>()), discoverDavAccount: discovery }));
// These tests exercise real transactions without contacting users' DAV servers.
vi.mock('./externalCalendarSync.js', () => ({ releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn().mockResolvedValue(undefined), syncCalendarSource: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./carddavSync.js', () => ({ scheduleCardavUser: vi.fn(), stopCardavUser: vi.fn(), syncUser: vi.fn().mockResolvedValue(undefined) }));
import { createDavAccount, deleteDavAccount, listDavAccounts, syncDavAccount, updateDavAccount } from './davAccounts.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
suite('settings unification against PostgreSQL', () => {
  let userId: string; let foreignId: string;
  beforeEach(async () => {
    discovery.mockReset(); userId = randomUUID(); foreignId = randomUUID();
    await query('INSERT INTO users (id,username) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)', [userId,foreignId]);
  });
  afterEach(async () => { await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,foreignId]]); });
  async function mailbox(transport='microsoft_graph') {
    const accountId = randomUUID(); const connectionId = randomUUID();
    await query("INSERT INTO provider_connections (id,user_id,provider) VALUES ($1,$2,$3)", [connectionId,userId,transport==='gmail_api'?'google':'microsoft']);
    await query(`INSERT INTO email_accounts (id,user_id,name,email_address,mail_transport,provider_connection_id)
      VALUES ($1,$2,'Test','owner@example.test',$3,$4)`, [accountId,userId,transport,connectionId]);
    return { accountId,connectionId };
  }
  async function source(kind: 'calendar'|'contacts', options: { enabled?: boolean; password?: string; username?: string; url?: string } = {}) {
    const id = randomUUID(); const username=options.username||'owner'; const password=encrypt(options.password||'app-password');
    const url=options.url || `https://dav.example.test/remote.php/dav/${kind==='calendar'?'calendars':'addressbooks'}/${username}/private/`;
    if(kind==='calendar') await query(`INSERT INTO calendar_import_sources (id,user_id,kind,url,username,password,display_name,interval_min,enabled,url_fingerprint)
      VALUES ($1,$2,'caldav',$3,$4,$5,'Private',60,$6,$7)`, [id,userId,encrypt(url),username,password,options.enabled!==false,externalSourceFingerprint(url)]);
    else await query(`INSERT INTO user_integrations (id,user_id,provider,label,config) VALUES ($1::uuid,$2,'carddav',$1::text,$3::jsonb)`,
      [id,userId,JSON.stringify({serverUrl:url,username,password,intervalMin:60,enabled:options.enabled!==false})]);
    return id;
  }
  it('merges only the same DAV identity, preserving source IDs, events, contacts and per-source pause flags', async () => {
    const calendarSource=await source('calendar'); const pausedSource=await source('calendar',{enabled:false,url:'https://dav.example.test/remote.php/dav/calendars/owner/paused/'});
    const contactSource=await source('contacts');
    const calendarId=randomUUID(); const eventId=randomUUID(); const bookId=randomUUID(); const contactId=randomUUID();
    await query(`INSERT INTO calendars (id,user_id,owner_user_id,source,external_url,name,color) VALUES ($1,$2,$2,'caldav',$3,'Custom name','#35558a')`,[calendarId,userId,`source:${calendarSource}`]);
    await query(`INSERT INTO calendar_events (id,calendar_id,user_id,uid,summary,starts_at,ends_at) VALUES ($1,$2,$3,'original-event','Keep me',NOW(),NOW()+interval '1 hour')`,[eventId,calendarId,userId]);
    await query(`INSERT INTO address_books (id,user_id,name,source) VALUES ($1,$2,'Custom book','carddav')`,[bookId,userId]);
    await query(`INSERT INTO contacts (id,user_id,address_book_id,uid) VALUES ($1,$2,$3,'original-contact')`,[contactId,userId,bookId]);
    await Promise.all([migrateDavAccounts(userId),migrateDavAccounts(userId)]);
    const accounts=await listDavAccounts(userId);
    expect(accounts).toHaveLength(1); expect(accounts[0]).toMatchObject({calendarEnabled:true,contactsEnabled:true,calendarSupported:true,contactsSupported:true});
    expect(JSON.stringify(accounts)).not.toContain('app-password'); expect(JSON.stringify(accounts)).not.toContain('password');
    const sources=await query<{id:string;dav_account_id:string;enabled:boolean}>('SELECT id,dav_account_id,enabled FROM calendar_import_sources WHERE user_id=$1 ORDER BY id',[userId]);
    expect(sources.rows.map(row=>row.id).sort()).toEqual([calendarSource,pausedSource].sort());
    expect(sources.rows.every(row=>row.dav_account_id===accounts[0].id)).toBe(true);
    expect(sources.rows.find(row=>row.id===pausedSource)?.enabled).toBe(false);
    expect((await query('SELECT id FROM user_integrations WHERE id=$1 AND dav_account_id=$2',[contactSource,accounts[0].id])).rows).toHaveLength(1);
    expect((await query('SELECT id FROM calendar_events WHERE id=$1',[eventId])).rows).toHaveLength(1);
    expect((await query('SELECT id FROM contacts WHERE id=$1',[contactId])).rows).toHaveLength(1);
    const renamed=await updateDavAccount(userId,accounts[0].id,{...accounts[0],name:'Renamed'});
    expect((await query<{enabled:boolean}>('SELECT enabled FROM calendar_import_sources WHERE id=$1',[pausedSource])).rows[0].enabled).toBe(false);
    const paused=await updateDavAccount(userId,renamed.id,{...renamed,calendarEnabled:false,contactsEnabled:false});
    expect((await query<{enabled:boolean}>('SELECT enabled FROM calendar_import_sources WHERE id=$1',[calendarSource])).rows[0].enabled).toBe(false);
    expect((await query<{config:{enabled:boolean}}>('SELECT config FROM user_integrations WHERE id=$1',[contactSource])).rows[0].config.enabled).toBe(false);
    expect((await query('SELECT id FROM calendar_events WHERE id=$1',[eventId])).rows).toHaveLength(1);
    expect((await query('SELECT id FROM contacts WHERE id=$1',[contactId])).rows).toHaveLength(1);
    await expect(updateDavAccount(userId,paused.id,{...accounts[0],name:'Stale edit'})).rejects.toMatchObject({code:'DAV_ACCOUNT_CHANGED',status:409});
    await expect(deleteDavAccount(foreignId,paused.id)).rejects.toMatchObject({status:404});
  });
  it('does not merge different passwords, usernames, unknown paths or undecryptable secrets', async () => {
    await source('calendar'); await source('contacts',{password:'different-secret'});
    await source('contacts',{username:'another-owner'});
    await source('calendar',{url:'https://unknown.example.test/a/'}); await source('contacts',{url:'https://unknown.example.test/b/'});
    await migrateDavAccounts(userId);
    expect(await listDavAccounts(userId)).toHaveLength(5);
    const unreadable = encrypt('secret').slice(0,-3) + '000';
    expect(sameDavIdentity({server_url:'https://dav.example.test/',username:'x',password:unreadable}, {server_url:'https://dav.example.test/',username:'x',password:unreadable})).toBe(false);
  });
  it('the database refuses a cross-user DAV source link', async () => {
    const sourceId=await source('calendar');await migrateDavAccounts(userId); const [account]=await listDavAccounts(userId);
    await expect(query('UPDATE calendar_import_sources SET user_id=$2,dav_account_id=$3 WHERE id=$1',[sourceId,foreignId,account.id])).rejects.toMatchObject({code:'23503'});
  });
  const connectionInput = () => ({ serverUrl:'https://dav.example.test/dav/', username:'owner', password:'new-app-password', name:'Private DAV', intervalMin:60, calendarEnabled:true, contactsEnabled:true });
  const discovered = (calendar=true,contacts=true) => ({
    calendars: calendar ? { homeUrl:'https://dav.example.test/calendars/', resourceUrls:['https://dav.example.test/calendars/private/'], collections:[{url:'https://dav.example.test/calendars/private/',displayName:'Private'}] } : null,
    contacts: contacts ? { homeUrl:'https://dav.example.test/books/', resourceUrls:['https://dav.example.test/books/private/'], collections:[{url:'https://dav.example.test/books/private/',displayName:'Contacts'}] } : null,
  });
  it.each([[true,true],[true,false],[false,true]])('creates a DAV account for supported calendar=%s contacts=%s without losing discovered service roots', async (calendar,contacts) => {
    discovery.mockResolvedValue(discovered(calendar,contacts));
    const input={...connectionInput(),calendarEnabled:calendar,contactsEnabled:contacts};
    const created=await createDavAccount(userId,input);
    expect(created).toMatchObject({calendarSupported:calendar,contactsSupported:contacts,calendarEnabled:calendar,contactsEnabled:contacts});
    expect(created).not.toHaveProperty('password');
    const stored=(await query<{server_url:string;password:string}>('SELECT server_url,password FROM dav_accounts WHERE id=$1',[created.id])).rows[0];
    expect(stored.password).not.toBe(input.password);expect(decrypt(stored.password)).toBe(input.password);
    const linkedCalendars=await query('SELECT id FROM calendar_import_sources WHERE dav_account_id=$1',[created.id]);
    expect(linkedCalendars.rows).toHaveLength(calendar?1:0);
    const linkedBooks=await query<{config:{serverUrl:string;homeSetUrl:string;password:string;enabled:boolean}}>('SELECT config FROM user_integrations WHERE dav_account_id=$1',[created.id]);
    expect(linkedBooks.rows).toHaveLength(contacts?1:0);
    if(contacts)expect(linkedBooks.rows[0].config).toMatchObject({serverUrl:input.serverUrl,homeSetUrl:discovered().contacts!.homeUrl,enabled:true});
    const repeated=await Promise.all([createDavAccount(userId,input),createDavAccount(userId,input)]);
    expect(repeated.map(row=>row.id)).toEqual([created.id,created.id]);expect(await listDavAccounts(userId)).toHaveLength(1);
  });
  it('retains disabled services without syncing them and updates encrypted credentials on the existing sources', async()=>{
    discovery.mockResolvedValue(discovered());
    const created=await createDavAccount(userId,{...connectionInput(),calendarEnabled:false});
    const sourceIds=(await query('SELECT id FROM calendar_import_sources WHERE dav_account_id=$1',[created.id])).rows;
    expect((await query<{enabled:boolean}>('SELECT enabled FROM calendar_import_sources WHERE dav_account_id=$1',[created.id])).rows[0].enabled).toBe(false);
    const updated=await updateDavAccount(userId,created.id,{...created,password:'replacement',calendarEnabled:true,contactsEnabled:false});
    expect(updated).toMatchObject({calendarEnabled:true,contactsEnabled:false});expect(updated.revision).not.toBe(created.revision);
    const calendars=(await query<{id:string;password:string;enabled:boolean}>('SELECT id,password,enabled FROM calendar_import_sources WHERE dav_account_id=$1',[created.id])).rows;
    expect(calendars.map(row=>({id:row.id}))).toEqual(sourceIds);expect(decrypt(calendars[0].password)).toBe('replacement');expect(calendars[0].enabled).toBe(true);
    const contact=(await query<{config:{password:string;enabled:boolean}}>('SELECT config FROM user_integrations WHERE dav_account_id=$1',[created.id])).rows[0];
    expect(decrypt(contact.config.password)).toBe('replacement');expect(contact.config.enabled).toBe(false);
    await expect(updateDavAccount(userId,created.id,{...created,name:'Stale name'})).rejects.toMatchObject({status:409});
  });
  it('does not apply a discovered snapshot after a concurrent edit within the same millisecond', async()=>{
    discovery.mockResolvedValue(discovered());
    const created=await createDavAccount(userId,connectionInput());
    await query("UPDATE dav_accounts SET updated_at='2026-09-29T12:00:00.000100Z' WHERE id=$1",[created.id]);
    discovery.mockImplementationOnce(async()=>{
      await query("UPDATE dav_accounts SET name='Concurrent edit',updated_at='2026-09-29T12:00:00.000900Z' WHERE id=$1",[created.id]);
      return discovered();
    });
    await expect(syncDavAccount(userId,created.id)).rejects.toMatchObject({code:'DAV_ACCOUNT_CHANGED'});
    expect((await listDavAccounts(userId))[0].name).toBe('Concurrent edit');
  });
  it('rejects unsupported services, failed discovery and conflicting ownership without leaving partial accounts',async()=>{
    discovery.mockResolvedValue(discovered(true,false));
    await expect(createDavAccount(userId,connectionInput())).rejects.toMatchObject({code:'DAV_SERVICE_UNAVAILABLE'});
    expect(await listDavAccounts(userId)).toEqual([]);
    discovery.mockRejectedValueOnce(new Error('discovery failed'));
    await expect(createDavAccount(userId,connectionInput())).rejects.toThrow('discovery failed');
    expect(await listDavAccounts(userId)).toEqual([]);
    discovery.mockResolvedValue(discovered());
    await createDavAccount(userId,connectionInput());
    await expect(createDavAccount(userId,{...connectionInput(),username:'other',password:'different'})).rejects.toMatchObject({code:'DAV_COLLECTION_ALREADY_CONNECTED'});
    expect(await listDavAccounts(userId)).toHaveLength(1);
    const own=(await listDavAccounts(userId))[0];
    await expect(updateDavAccount(foreignId,own.id,{...own,name:'Foreign edit'})).rejects.toMatchObject({status:404});
    await deleteDavAccount(userId,own.id);
    expect(await listDavAccounts(userId)).toEqual([]);
    expect((await query('SELECT id FROM calendar_import_sources WHERE dav_account_id=$1',[own.id])).rows).toEqual([]);
    expect((await query('SELECT id FROM user_integrations WHERE dav_account_id=$1',[own.id])).rows).toEqual([]);
  });
  it('allows owned API-only sender aliases and rejects cross-account or unavailable identities', async () => {
    const {accountId}=await mailbox(); const aliasId=randomUUID(); const secondAliasId=randomUUID();
    await query("INSERT INTO account_aliases (id,account_id,name,email) VALUES ($1,$3,'First','first@example.test'),($2,$3,'Second','second@example.test')",[aliasId,secondAliasId,accountId]);
    for(const selected of [aliasId,secondAliasId]) {
      const patch=await calendarPreferencePatch(userId,{calendarInviteAccountId:accountId,calendarInviteAliasId:selected,calendarShowAgenda:false});
      await query('UPDATE users SET preferences=preferences || $2::jsonb WHERE id=$1',[userId,JSON.stringify(patch)]);
      expect((await query<{preferences:Record<string,unknown>}>('SELECT preferences FROM users WHERE id=$1',[userId])).rows[0].preferences).toMatchObject({calendarInviteAccountId:accountId,calendarInviteAliasId:selected,calendarShowAgenda:false});
    }
    await expect(calendarPreferencePatch(foreignId,{calendarInviteAccountId:accountId,calendarInviteAliasId:aliasId})).rejects.toMatchObject({status:400});
    const other=await mailbox('gmail_api');
    await expect(calendarPreferencePatch(userId,{calendarInviteAccountId:other.accountId,calendarInviteAliasId:aliasId})).rejects.toMatchObject({status:400});
    expect(await withInvitationAlias({id:accountId,email_address:'owner@example.test'},secondAliasId)).toMatchObject({invitation_from_email:'second@example.test'});
    await query('DELETE FROM account_aliases WHERE id=$1',[secondAliasId]);
    await expect(withInvitationAlias({id:accountId,email_address:'owner@example.test'},secondAliasId)).rejects.toMatchObject({status:409});
    expect(await calendarPreferencePatch(userId,{calendarInviteAccountId:'',calendarInviteAliasId:''})).toEqual({calendarInviteAccountId:'',calendarInviteAliasId:''});
    await expect(calendarPreferencePatch(userId,{calendarShowAgenda:'false'})).rejects.toMatchObject({status:400});
  });
  it.each(['gmail_api','microsoft_graph'])('reindexes %s only under its own lease and exposes progress without stale folders', async transport => {
    const {accountId,connectionId}=await mailbox(transport);const collectionId=randomUUID();
    await query("INSERT INTO integration_collections (id,user_id,connection_id,account_id,kind,remote_id) VALUES ($1,$2,$3,$4,'mail_folder','inbox')",[collectionId,userId,connectionId,accountId]);
    const syncStateId=await withTransaction(client=>ensureSyncState(client,{userId,connectionId,accountId,feature:'mail',coverage:transport==='gmail_api'?'history':'messages',...(transport==='microsoft_graph'?{collectionId}:{})}));
    await query("UPDATE sync_states SET cursor='old-cursor',page_checkpoint='old-page' WHERE id=$1",[syncStateId]);
    const first=await withTransaction(client=>acquireSyncLease(client,{syncStateId,owner:'first'})); expect(first).not.toBeNull();
    await query('UPDATE email_accounts SET reindex_requested_at=clock_timestamp() WHERE id=$1',[accountId]);
    expect(await withTransaction(client=>acquireSyncLease(client,{syncStateId,owner:'second'}))).toBeNull();
    expect((await withTransaction(client=>readSyncState(client,syncStateId)))?.cursor).toBe('old-cursor');
    await withTransaction(client=>releaseSyncLease(client,{syncStateId,generation:first!.generation}));
    const second=await withTransaction(client=>acquireSyncLease(client,{syncStateId,owner:'second'})); expect(second).not.toBeNull();
    expect(await withTransaction(client=>readSyncState(client,syncStateId))).toMatchObject({cursor:null,pageCheckpoint:null});
    expect(await withTransaction(client=>commitSyncCheckpoint(client,{syncStateId,generation:first!.generation,cursor:'stale'}))).toBe(false);
    expect(await mailIndexDiagnostics(userId,accountId,false)).toMatchObject({status:'running'});
    await withTransaction(client=>commitSyncCheckpoint(client,{syncStateId,generation:second!.generation,cursor:'new-cursor',clearPageCheckpoint:true}));
    await withTransaction(client=>finishSyncRun(client,{syncStateId,generation:second!.generation}));
    await withTransaction(client=>releaseSyncLease(client,{syncStateId,generation:second!.generation}));
    expect(await mailIndexDiagnostics(userId,accountId,false)).toMatchObject({status:'ready'});
    expect(await mailIndexDiagnostics(foreignId,accountId,false)).toBeNull();
    const next=await withTransaction(client=>acquireSyncLease(client,{syncStateId,owner:'third'}));
    expect((await withTransaction(client=>readSyncState(client,syncStateId)))?.cursor).toBe('new-cursor');
    await withTransaction(client=>releaseSyncLease(client,{syncStateId,generation:next!.generation}));
  });
  it('loads a queued target outside pagination without reading bodies, pausing or acknowledging it', async()=>{
    const {accountId}=await mailbox();const id=randomUUID();
    await query(`INSERT INTO scheduled_mail (id,user_id,account_id,idempotency_key,request_fingerprint,mode,scheduled_at,time_zone,payload)
      VALUES ($1::uuid,$2,$3,$1::text,repeat('a',64),'schedule',NOW()+interval '1 day','Europe/Warsaw',$4::jsonb)`,[id,userId,accountId,JSON.stringify({senderEmail:'first@example.test',payload:{body:'private body',to:['guest@example.test']}})]);
    const result=await getScheduledSummary(userId,id);expect(result).toMatchObject({id,accountId,state:'pending',senderEmail:'first@example.test'});
    expect(JSON.stringify(result)).not.toContain('private body');
    await expect(getScheduledSummary(foreignId,id)).rejects.toMatchObject({status:404});
    await query("UPDATE scheduled_mail SET state='cancelled' WHERE id=$1",[id]);
    await expect(getScheduledSummary(userId,id)).rejects.toMatchObject({status:404});
  });
});
