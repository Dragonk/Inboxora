import { query, withTransaction } from './db.js';
import type { PoolClient } from 'pg';
import { decrypt, encrypt, isEncrypted } from './encryption.js';
import { normalizeDavCollectionUrl } from './davCollectionClient.js';

export interface DavAccountRow {
  id: string; user_id: string; name: string; server_url: string; username: string; password: string | null;
  calendar_enabled: boolean; contacts_enabled: boolean; calendar_supported: boolean; contacts_supported: boolean;
  interval_min: number; updated_at: string | Date; revision?: string;
}
/** Only well-known server layouts can safely collapse collection-specific paths. */
export function davAccountScope(value: string): string | null {
  try {
    const url = new URL(normalizeDavCollectionUrl(value));
    const nextcloud = /^(.*\/remote\.php)\/(?:dav|caldav|carddav)(?:\/|$)/.exec(url.pathname);
    const baikal = /^(.*\/dav\.php)(?:\/|$)/.exec(url.pathname);
    const standard = /^(.*\/dav)\/(?:calendars|addressbooks|principals)(?:\/|$)/.exec(url.pathname);
    if (nextcloud) url.pathname = nextcloud[1] + '/dav/';
    else if (baikal) url.pathname = baikal[1] + '/';
    else if (standard) url.pathname = standard[1] + '/';
    return url.href;
  } catch { return null; }
}
export function sameDavIdentity(a: Pick<DavAccountRow, 'server_url' | 'username' | 'password'>, b: Pick<DavAccountRow, 'server_url' | 'username' | 'password'>): boolean {
  if (!a.password || !b.password || a.username !== b.username) return false;
  const leftUrl = decrypt(a.server_url); const rightUrl = decrypt(b.server_url);
  const leftSecret = decrypt(a.password); const rightSecret = decrypt(b.password);
  const scope = leftUrl && davAccountScope(leftUrl);
  return Boolean(scope && rightUrl && scope === davAccountScope(rightUrl) && leftSecret && leftSecret === rightSecret);
}
export async function lockDavAccounts(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dav-accounts:${userId}`]);
}
const secret = (value: string): string => isEncrypted(value) ? value : encrypt(value);

export async function migrateDavAccounts(userId: string): Promise<void> {
  await withTransaction(async client => {
    await lockDavAccounts(client, userId);
    const accounts = (await client.query<DavAccountRow>('SELECT * FROM dav_accounts WHERE user_id = $1 ORDER BY created_at, id FOR UPDATE', [userId])).rows;
    const calendars = await client.query<{ id: string; url: string; username: string | null; password: string | null; display_name: string; interval_min: number; enabled: boolean }>(
      `SELECT id, url, username, password, display_name, interval_min, enabled FROM calendar_import_sources
       WHERE user_id = $1 AND kind = 'caldav' AND dav_account_id IS NULL ORDER BY created_at, id FOR UPDATE`, [userId]);
    const contacts = await client.query<{ id: string; label: string | null; config: { serverUrl?: string; username?: string; password?: string; intervalMin?: number; enabled?: boolean } }>(
      `SELECT id, label, config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav' AND dav_account_id IS NULL ORDER BY created_at, id FOR UPDATE`, [userId]);
    const sources = [
      ...calendars.rows.map(row => ({ id: row.id, kind: 'calendar' as const, name: row.display_name, server_url: row.url,
        username: row.username || '', password: row.password, interval: row.interval_min, enabled: row.enabled })),
      ...contacts.rows.map(row => ({ id: row.id, kind: 'contacts' as const, name: row.label || row.config.username || 'DAV',
        server_url: secret(row.config.serverUrl || ''), username: row.config.username || '', password: row.config.password || null,
        interval: row.config.intervalMin || 60, enabled: row.config.enabled !== false })),
    ];
    for (const source of sources) {
      let account = accounts.find(item => sameDavIdentity(item, source));
      if (!account) {
        const plain = decrypt(source.server_url);
        const root = plain && davAccountScope(plain);
        account = (await client.query<DavAccountRow>(`INSERT INTO dav_accounts (user_id, name, server_url, username, password, interval_min)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [userId, (source.name || 'DAV').slice(0,120), root ? encrypt(root) : source.server_url,
          source.username, source.password ? secret(source.password) : null, Math.max(15, Math.min(1440, source.interval))])).rows[0];
        accounts.push(account);
      }
      const calendar = source.kind === 'calendar';
      account.calendar_supported ||= calendar; account.contacts_supported ||= !calendar;
      account.calendar_enabled ||= calendar && source.enabled; account.contacts_enabled ||= !calendar && source.enabled;
      await client.query(`UPDATE dav_accounts SET calendar_supported=$2, contacts_supported=$3, calendar_enabled=$4, contacts_enabled=$5 WHERE id=$1`,
        [account.id, account.calendar_supported, account.contacts_supported, account.calendar_enabled, account.contacts_enabled]);
      if (calendar) await client.query('UPDATE calendar_import_sources SET dav_account_id=$1 WHERE id=$2 AND user_id=$3', [account.id, source.id, userId]);
      else await client.query('UPDATE user_integrations SET dav_account_id=$1 WHERE id=$2 AND user_id=$3', [account.id, source.id, userId]);
    }
  });
}
export async function migrateAllDavAccounts(): Promise<void> {
  const users = await query<{ user_id: string }>(`SELECT DISTINCT user_id FROM calendar_import_sources WHERE kind='caldav' AND dav_account_id IS NULL
    UNION SELECT DISTINCT user_id FROM user_integrations WHERE provider='carddav' AND dav_account_id IS NULL`);
  for (const row of users.rows) await migrateDavAccounts(row.user_id);
}
