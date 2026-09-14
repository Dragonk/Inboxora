import { query } from '../services/db.js';

// Generic per-plugin storage — lets a plugin own data without raw DB access.
//
// A record is keyed by (pluginId, key) and holds a JSON `value`, an optional binary `blob`
// (+ mime), an optional `ownerId` (a user; the row is cascade-deleted when they're deleted),
// and a `visibility` flag the plugin can use for its own read gating. Modeled on the existing
// user_integrations table, extended to carry blobs. See migration 0041_plugin_data.sql.
//
// This is the first safe, generic capability of the plugin platform: the GTD inbox-zero pet
// is its first consumer, and it's the storage surface future (sandboxed) plugins will use.

/** Options for a plugin-storage write. */
export interface PutOptions {
  value?: unknown;
  blob?: Buffer | null;
  mime?: string | null;
  ownerId?: string | null;
  visibility?: string;
}

/** A plugin_data row as the storage helpers expose it. */
export interface PluginDataRow {
  key?: string;
  owner_id?: string | null;
  value?: unknown;
  visibility?: string;
  blob?: Buffer | null;
  blob_mime?: string | null;
  [column: string]: unknown;
}


export async function put(pluginId: string, key: string, { value = {}, blob = null, mime = null, ownerId = null, visibility = 'private' }: PutOptions = {}): Promise<void> {
  await query(
    `INSERT INTO plugin_data (plugin_id, key, owner_id, value, blob, blob_mime, visibility, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW())
     ON CONFLICT (plugin_id, key) DO UPDATE SET
       owner_id   = EXCLUDED.owner_id,
       value      = EXCLUDED.value,
       blob       = EXCLUDED.blob,
       blob_mime  = EXCLUDED.blob_mime,
       visibility = EXCLUDED.visibility,
       updated_at = NOW()`,
    [pluginId, key, ownerId, JSON.stringify(value), blob, mime, visibility]
  );
}

// Metadata (no blob) — key, owner, JSON value, visibility. Null when absent.
export async function getValue(pluginId: string, key: string): Promise<{ key: string; owner_id?: string | null; value: Record<string, unknown>; visibility?: string | null } | null> {
  const { rows } = await query<{ key: string; owner_id?: string | null; value: Record<string, unknown>; visibility?: string | null }>(
    `SELECT key, owner_id, value, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

// The binary blob + mime (and owner/visibility for gating). Null when absent.
export async function getBlob(pluginId: string, key: string): Promise<{ blob: Buffer | string; blob_mime?: string | null; owner_id?: string | null; visibility?: string | null } | null> {
  const { rows } = await query<{ blob: Buffer | string; blob_mime?: string | null; owner_id?: string | null; visibility?: string | null }>(
    `SELECT blob, blob_mime, owner_id, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

export async function del(pluginId: string, key: string) {
  await query(`DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2`, [pluginId, key]);
}
