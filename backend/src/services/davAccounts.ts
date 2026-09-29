import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { discoverDavAccount, DavAccountError, type DavCredentials, type DavDiscovery } from './davDiscovery.js';
import { lockDavAccounts, migrateDavAccounts, sameDavIdentity, type DavAccountRow } from './davAccountMigration.js';
import { normalizeDavCollectionUrl } from './davCollectionClient.js';
import { externalSourceFingerprint } from './providers/externalCollectionLinks.js';
import { releaseCalendarSource, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } from './externalCalendarSync.js';
import { scheduleCardavUser, stopCardavUser, syncUser } from './carddavSync.js';

export interface DavAccountInput extends DavCredentials {
  name: string; calendarEnabled: boolean; contactsEnabled: boolean; intervalMin: number;
}
function safeUrl(value: string): string {
  const decrypted = decrypt(value);
  if (!decrypted) return '';
  try { const url = new URL(decrypted); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return ''; }
}
export function publicDavAccount(row: DavAccountRow) {
  return { id: row.id, name: row.name, serverUrl: safeUrl(row.server_url), username: row.username,
    calendarEnabled: row.calendar_enabled, contactsEnabled: row.contacts_enabled,
    calendarSupported: row.calendar_supported, contactsSupported: row.contacts_supported,
    intervalMin: row.interval_min, revision: row.revision ?? new Date(row.updated_at).toISOString() };
}
async function ownedAccount(userId: string, id: string): Promise<DavAccountRow> {
  const row = (await query<DavAccountRow>('SELECT *,updated_at::text AS revision FROM dav_accounts WHERE id=$1 AND user_id=$2', [id,userId])).rows[0];
  if (!row) throw new DavAccountError('DAV_ACCOUNT_NOT_FOUND',404);
  return row;
}
export async function listDavAccounts(userId: string) {
  await migrateDavAccounts(userId);
  return (await query<DavAccountRow>('SELECT *,updated_at::text AS revision FROM dav_accounts WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows.map(publicDavAccount);
}
/** Link discovery results without stealing an existing source from another identity. */
async function attachDiscoveredSources(client: PoolClient, row: DavAccountRow, credentials: DavCredentials, discovery: DavDiscovery): Promise<void> {
  const legacy = await client.query<{ id:string; url:string; dav_account_id:string|null }>(
    "SELECT id,url,dav_account_id FROM calendar_import_sources WHERE user_id=$1 AND kind='caldav' FOR UPDATE", [row.user_id]);
  const canonical = (encrypted: string) => { try { return normalizeDavCollectionUrl(decrypt(encrypted) || ''); } catch { return null; } };
  for (const calendar of discovery.calendars?.collections || []) {
    const url = normalizeDavCollectionUrl(calendar.url); const fingerprint = externalSourceFingerprint(url);
    const existing = await client.query<{ id: string; dav_account_id: string | null }>(
      'SELECT id,dav_account_id FROM calendar_import_sources WHERE user_id=$1 AND url_fingerprint=$2 FOR UPDATE', [row.user_id,fingerprint]);
    const previous = existing.rows[0] || legacy.rows.find(source => canonical(source.url) === url);
    if (previous) {
      if (previous.dav_account_id !== row.id) throw new DavAccountError('DAV_COLLECTION_ALREADY_CONNECTED',409);
      continue;
    }
    await client.query(`INSERT INTO calendar_import_sources (user_id,kind,url,url_fingerprint,username,password,display_name,color,interval_min,enabled,dav_account_id)
      VALUES ($1,'caldav',$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [row.user_id,encrypt(url),fingerprint,credentials.username,encrypt(credentials.password),
      calendar.displayName.slice(0,120) || row.name, calendar.color && /^#[0-9a-f]{6}$/i.test(calendar.color) ? calendar.color : null,
      row.interval_min,row.calendar_enabled,row.id]);
  }
  if (discovery.contacts) {
    const existing = await client.query("SELECT id FROM user_integrations WHERE user_id=$1 AND dav_account_id=$2 AND provider='carddav'", [row.user_id,row.id]);
    if (!existing.rows.length) {
      // A unique internal source label avoids the legacy labelled-provider upsert
      // replacing another account. The presentation label comes from dav_accounts.
      await client.query(`INSERT INTO user_integrations (user_id,provider,label,config,dav_account_id) VALUES ($1,'carddav',$2,$3::jsonb,$4)`,
        [row.user_id,`${row.name} [${row.id}]`,JSON.stringify({ serverUrl: credentials.serverUrl, homeSetUrl: discovery.contacts.homeUrl, username:credentials.username,
          password:encrypt(credentials.password),intervalMin:row.interval_min,dupMode:'separate',enabled:row.contacts_enabled }),row.id]);
    }
  }
}
async function applySchedulers(userId: string, id: string, sync = false): Promise<void> {
  const calendars = await query<{ id: string; user_id: string; interval_min: number; enabled: boolean }>(
    'SELECT id,user_id,interval_min,enabled FROM calendar_import_sources WHERE dav_account_id=$1 AND user_id=$2', [id,userId]);
  const contacts = await query<{ id: string; config: { enabled?: boolean; intervalMin?: number } }>(
    "SELECT id,config FROM user_integrations WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav'", [id,userId]);
  for (const source of calendars.rows) {
    if (source.enabled) { releaseCalendarSource(source.id); scheduleCalendarSource(source);
      if (sync) void syncCalendarSource(userId,source.id).catch(() => console.warn('DAV calendar sync could not start:',source.id)); }
    else await stopCalendarSource(source.id);
  }
  for (const source of contacts.rows) {
    if (source.config.enabled !== false) { scheduleCardavUser(userId,source.config.intervalMin || 60,source.id);
      if (sync) void syncUser(userId,source.id).catch(() => console.warn('DAV contact sync could not start:',source.id)); }
    else stopCardavUser(source.id);
  }
}
export async function createDavAccount(userId: string, input: DavAccountInput) {
  await migrateDavAccounts(userId);
  let serverUrl: string;
  try { serverUrl = normalizeDavCollectionUrl(input.serverUrl); } catch { throw new DavAccountError('DAV_INVALID_URL'); }
  const credentials = { serverUrl, username:input.username,password:input.password };
  const discovery = await discoverDavAccount(credentials);
  if ((input.calendarEnabled && !discovery.calendars) || (input.contactsEnabled && !discovery.contacts)) throw new DavAccountError('DAV_SERVICE_UNAVAILABLE');
  const row = await withTransaction(async client => {
    await lockDavAccounts(client,userId);
    const existing = await client.query<DavAccountRow>('SELECT *,updated_at::text AS revision FROM dav_accounts WHERE user_id=$1 FOR UPDATE', [userId]);
    const duplicate = existing.rows.find(item => sameDavIdentity(item, { server_url:credentials.serverUrl,username:credentials.username,password:credentials.password }));
    // Lost create responses are safe to repeat; never replace a source by label.
    if (duplicate) {
      if (duplicate.name !== input.name || duplicate.interval_min !== input.intervalMin
        || duplicate.calendar_enabled !== input.calendarEnabled || duplicate.contacts_enabled !== input.contactsEnabled) {
        throw new DavAccountError('DAV_COLLECTION_ALREADY_CONNECTED',409);
      }
      return duplicate;
    }
    const account = (await client.query<DavAccountRow>(`INSERT INTO dav_accounts (id,user_id,name,server_url,username,password,calendar_enabled,contacts_enabled,calendar_supported,contacts_supported,interval_min)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *,updated_at::text AS revision`, [randomUUID(),userId,input.name,encrypt(credentials.serverUrl),credentials.username,encrypt(credentials.password),
      input.calendarEnabled,input.contactsEnabled,Boolean(discovery.calendars),Boolean(discovery.contacts),input.intervalMin])).rows[0];
    await attachDiscoveredSources(client,account,credentials,discovery);
    return account;
  });
  await applySchedulers(userId,row.id,true);
  return publicDavAccount(row);
}
export interface DavAccountPatch { name: string; password?: string; calendarEnabled: boolean; contactsEnabled: boolean; intervalMin: number; revision: string }
export async function updateDavAccount(userId: string,id: string,input: DavAccountPatch) {
  const before = await ownedAccount(userId,id);
  const credentials = {serverUrl:decrypt(before.server_url) || '',username:before.username,password:input.password || (before.password && decrypt(before.password)) || ''};
  const needsDiscovery = Boolean(input.password || (input.calendarEnabled && !before.calendar_supported) || (input.contactsEnabled && !before.contacts_supported));
  const discovery = needsDiscovery ? await discoverDavAccount(credentials) : null;
  if ((input.calendarEnabled && !(discovery?.calendars || before.calendar_supported))
    || (input.contactsEnabled && !(discovery?.contacts || before.contacts_supported))) throw new DavAccountError('DAV_SERVICE_UNAVAILABLE');
  const row = await withTransaction(async client => {
    await lockDavAccounts(client,userId);
    const current = (await client.query<DavAccountRow>('SELECT *,updated_at::text AS revision FROM dav_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE', [id,userId])).rows[0];
    if (!current) throw new DavAccountError('DAV_ACCOUNT_NOT_FOUND',404);
    if (publicDavAccount(current).revision !== input.revision) throw new DavAccountError('DAV_ACCOUNT_CHANGED',409);
    // Serialize with projection/deletion operations before changing their source
    // revisions. An already-fetched snapshot fails its normal source fence.
    const sources = await client.query<{id:string;kind:string}>(`SELECT id,'calendar' AS kind FROM calendar_import_sources WHERE dav_account_id=$1 AND user_id=$2
      UNION ALL SELECT id,'addressbook' FROM user_integrations WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav' ORDER BY id`, [id,userId]);
    for (const source of sources.rows) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dav:${userId}:${source.kind}:${source.id}`]);
    if (input.password) {
      const pending = await client.query(`SELECT id FROM dav_collection_operations WHERE user_id=$1 AND source_id=ANY($2::uuid[]) AND status IN ('pending','confirmed') LIMIT 1`,[userId,sources.rows.map(source=>source.id)]);
      if (pending.rows.length) throw new DavAccountError('DAV_OPERATION_PENDING',409);
    }
    const saved = (await client.query<DavAccountRow>(`UPDATE dav_accounts SET name=$3,password=COALESCE($4,password),calendar_enabled=$5,contacts_enabled=$6,
      interval_min=$7,calendar_supported=calendar_supported OR $8,contacts_supported=contacts_supported OR $9,updated_at=clock_timestamp()
      WHERE id=$1 AND user_id=$2 RETURNING *,updated_at::text AS revision`,[id,userId,input.name,input.password ? encrypt(input.password) : null,input.calendarEnabled,input.contactsEnabled,input.intervalMin,Boolean(discovery?.calendars),Boolean(discovery?.contacts)])).rows[0];
    if (discovery) await attachDiscoveredSources(client,saved,credentials,discovery);
    await client.query(`UPDATE calendar_import_sources SET enabled=CASE WHEN $6 THEN $3 ELSE enabled END,interval_min=$4,password=COALESCE($5,password),updated_at=NOW() WHERE dav_account_id=$1 AND user_id=$2`,
      [id,userId,input.calendarEnabled,input.intervalMin,input.password ? encrypt(input.password) : null,current.calendar_enabled !== input.calendarEnabled]);
    const patch = {...(current.contacts_enabled !== input.contactsEnabled ? {enabled:input.contactsEnabled} : {}),intervalMin:input.intervalMin,...(input.password ? {password:encrypt(input.password)} : {})};
    await client.query(`UPDATE user_integrations SET config=config || $3::jsonb,updated_at=NOW() WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav'`,[id,userId,JSON.stringify(patch)]);
    await client.query(`UPDATE source_connections sc SET enabled=COALESCE(i.config->>'enabled','true') <> 'false',updated_at=NOW() FROM user_integrations i
      WHERE i.id=sc.integration_id AND i.user_id=$2 AND sc.user_id=$2 AND i.dav_account_id=$1 AND sc.kind='carddav'`,[id,userId]);
    return saved;
  });
  await applySchedulers(userId,id);
  return publicDavAccount(row);
}
export async function davAccountDiagnostics(userId: string,id: string) {
  await ownedAccount(userId,id);
  const calendars = await query<{id:string;name:string;last_sync_at:string|null;last_error:string|null;enabled:boolean}>(
    `SELECT id,display_name AS name,last_sync_at,last_error,enabled FROM calendar_import_sources WHERE dav_account_id=$1 AND user_id=$2 ORDER BY created_at,id`,[id,userId]);
  const contacts = await query<{id:string;last_sync_at:string|null;last_error:string|null;enabled:boolean}>(`SELECT id,config->>'lastSyncAt' AS last_sync_at,config->>'lastError' AS last_error,COALESCE(config->>'enabled','true') <> 'false' AS enabled
    FROM user_integrations WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav' ORDER BY created_at,id`,[id,userId]);
  return {calendars:calendars.rows.map(source=>({...source,failed:Boolean(source.last_error),last_error:undefined})),
    contacts:contacts.rows.map(source=>({...source,failed:Boolean(source.last_error),last_error:undefined}))};
}
export async function discoverSavedDavAccount(userId:string,id:string,password?:string) {
  const row=await ownedAccount(userId,id);
  return discoverDavAccount({serverUrl:decrypt(row.server_url)||'',username:row.username,password:password||(row.password&&decrypt(row.password))||''});
}
export async function syncDavAccount(userId: string,id: string): Promise<void> {
  const before = await ownedAccount(userId,id);
  const credentials = {serverUrl:decrypt(before.server_url) || '',username:before.username,password:before.password && decrypt(before.password) || ''};
  const discovery = await discoverDavAccount(credentials);
  await withTransaction(async client => {
    await lockDavAccounts(client,userId);
    const current = (await client.query<DavAccountRow>('SELECT *,updated_at::text AS revision FROM dav_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])).rows[0];
    if (!current) throw new DavAccountError('DAV_ACCOUNT_NOT_FOUND',404);
    if (publicDavAccount(current).revision !== publicDavAccount(before).revision) throw new DavAccountError('DAV_ACCOUNT_CHANGED',409);
    await attachDiscoveredSources(client,current,credentials,discovery);
    await client.query(`UPDATE dav_accounts SET calendar_supported=calendar_supported OR $3,contacts_supported=contacts_supported OR $4,
      updated_at=CASE WHEN ($3 AND NOT calendar_supported) OR ($4 AND NOT contacts_supported) THEN clock_timestamp() ELSE updated_at END WHERE id=$1 AND user_id=$2`,
    [id,userId,Boolean(discovery.calendars),Boolean(discovery.contacts)]);
  });
  await applySchedulers(userId,id,true);
}
/** Disconnect removes only local mirrors, never a remote DAV resource. */
export async function deleteDavAccount(userId: string,id: string): Promise<void> {
  const calendarIds: string[] = []; const contactIds: string[] = [];
  await withTransaction(async client => {
    await lockDavAccounts(client,userId);
    const account = await client.query('SELECT id FROM dav_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
    if (!account.rows.length) throw new DavAccountError('DAV_ACCOUNT_NOT_FOUND',404);
    const sources = await client.query<{id:string;kind:string}>(`SELECT id,'calendar' AS kind FROM calendar_import_sources WHERE dav_account_id=$1 AND user_id=$2
      UNION ALL SELECT id,'addressbook' FROM user_integrations WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav' ORDER BY id`,[id,userId]);
    for (const source of sources.rows) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dav:${userId}:${source.kind}:${source.id}`]);
      (source.kind==='calendar' ? calendarIds : contactIds).push(source.id);
    }
    const pending = await client.query(`SELECT id FROM dav_collection_operations WHERE user_id=$1 AND source_id=ANY($2::uuid[]) AND status IN ('pending','confirmed') LIMIT 1`,[userId,sources.rows.map(source=>source.id)]);
    if (pending.rows.length) throw new DavAccountError('DAV_OPERATION_PENDING',409);
    // Delete links before their projections; source IDs remain protected by the
    // same tenant + source locks as the normal DAV projection transactions.
    await client.query(`DELETE FROM integration_collections ic USING calendars c WHERE ic.local_calendar_id=c.id AND c.user_id=$1 AND ic.user_id=$1 AND c.owner_user_id=$1 AND c.external_url=ANY($2::text[])`,[userId,calendarIds.map(source=>'source:'+source)]);
    await client.query(`DELETE FROM calendars WHERE user_id=$1 AND owner_user_id=$1 AND external_url=ANY($2::text[])`,[userId,calendarIds.map(source=>'source:'+source)]);
    await client.query(`DELETE FROM address_books ab USING source_connections sc WHERE ab.source_connection_id=sc.id AND ab.user_id=$1 AND sc.user_id=$1 AND ab.source='carddav' AND sc.integration_id=ANY($2::uuid[])`,[userId,contactIds]);
    await client.query('DELETE FROM calendar_import_sources WHERE dav_account_id=$1 AND user_id=$2',[id,userId]);
    await client.query("DELETE FROM user_integrations WHERE dav_account_id=$1 AND user_id=$2 AND provider='carddav'",[id,userId]);
    await client.query('DELETE FROM dav_accounts WHERE id=$1 AND user_id=$2',[id,userId]);
  });
  for (const source of calendarIds) { await stopCalendarSource(source); releaseCalendarSource(source); }
  contactIds.forEach(stopCardavUser);
}
