import { query } from './db.js';

export interface DavSyncResource {
  uid: string;
  recurrence_id?: string;
  dav_filename: string;
  etag: string | null;
  deleted: boolean;
  raw_ical?: string | null;
  vcard?: string | null;
}
export type DavKind = 'calendar' | 'contacts';
export interface DavSyncSnapshot {
  status: 'ok' | 'missing' | 'expired';
  token: string;
  resources: DavSyncResource[];
}

/** A SINGLE statement pins token, retention floor, tombstones and current payloads
 * to one MVCC snapshot. A cleanup or writer between two HTTP queries cannot make
 * us issue a token for changes we did not actually return. */
export async function readDavSyncSnapshot(kind: DavKind, id: string, userId: string, after: number | null): Promise<DavSyncSnapshot> {
  const isCalendar = kind === 'calendar';
  const collection = isCalendar ? 'calendars' : 'address_books';
  const canonical = isCalendar ? 'calendar_events' : 'contacts';
  const journal = isCalendar ? 'calendar_sync_changes' : 'contact_sync_changes';
  const scope = isCalendar ? 'calendar_id' : 'address_book_id';
  const filename = isCalendar ? 'dav_filename' : 'filename';
  const suffix = isCalendar ? '.ics' : '.vcf';
  const payload = isCalendar ? 'raw_ical' : 'vcard';
  const result = await query<{
    sync_version: string; sync_min_version: string; resources: DavSyncResource[];
  }>(`
    WITH owner AS (
      SELECT id, sync_version, sync_min_version FROM ${collection}
       WHERE id = $1 AND user_id = $2 AND dav_mode <> 'off'
    )
    SELECT o.sync_version::text, o.sync_min_version::text,
           COALESCE(jsonb_agg(r.resource ORDER BY r.path) FILTER (WHERE r.resource IS NOT NULL), '[]'::jsonb) AS resources
      FROM owner o
      LEFT JOIN LATERAL (
        SELECT COALESCE(e.dav_filename, e.uid || '${suffix}') AS path,
               jsonb_build_object('uid', e.uid, 'dav_filename', COALESCE(e.dav_filename, e.uid || '${suffix}'),
                 'etag', e.etag, 'deleted', false, '${payload}', e.${payload}) AS resource
          FROM ${canonical} e
         WHERE $3::bigint IS NULL AND e.${scope} = o.id ${isCalendar ? "AND e.recurrence_id = ''" : ''}
        UNION ALL
        SELECT j.${filename} AS path,
               jsonb_build_object('uid', ${isCalendar ? 'j.uid' : 'e.uid'}, 'dav_filename', j.${filename},
                 'etag', e.etag, 'deleted', j.deleted OR e.id IS NULL, '${payload}',
                 CASE WHEN j.deleted THEN NULL ELSE e.${payload} END) AS resource
          FROM ${journal} j
          LEFT JOIN ${canonical} e ON e.${scope} = j.${scope}
           AND COALESCE(e.dav_filename, e.uid || '${suffix}') = j.${filename}
           ${isCalendar ? 'AND e.recurrence_id = j.recurrence_id' : ''}
         WHERE $3::bigint IS NOT NULL AND $3 >= o.sync_min_version AND $3 <= o.sync_version
           AND j.${scope} = o.id AND j.version > $3 AND j.version <= o.sync_version
      ) r ON true
     GROUP BY o.id, o.sync_version, o.sync_min_version`, [id, userId, after]);
  const row = result.rows[0];
  if (!row) return { status: 'missing', token: '', resources: [] };
  if (after !== null && (BigInt(after) < BigInt(row.sync_min_version) || BigInt(after) > BigInt(row.sync_version))) {
    return { status: 'expired', token: '', resources: [] };
  }
  return { status: 'ok', resources: row.resources,
    token: isCalendar ? `sync-${row.sync_version}` : `urn:inboxora:carddav:${id}:${row.sync_version}` };
}
