import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction, type DbClient } from './db.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import {
  normalizeDavCollectionUrl, resolveDavHref, deleteDavCollection,
  discoverDavCollectionDeleteCapability, inspectDavCollection,
} from './davCollectionClient.js';

export type DavCollectionKind = 'calendar' | 'addressbook';
export interface DavCollectionDeleteResult {
  status: 'deleted' | 'not_found' | 'refused' | 'unknown';
  operationId?: string;
  reason?: string;
}
interface Operation {
  id: string; status: 'pending' | 'refused' | 'confirmed' | 'completed';
  source_id: string; remote_fingerprint: string; source_revision: string;
}
interface Binding {
  source_id: string; url: string; username: string; password: string;
  server_url: string; user_access: string | null;
}
const fingerprint = (url: string) => createHash('sha256').update(normalizeDavCollectionUrl(url)).digest('hex');
const key = (userId: string, kind: DavCollectionKind, sourceId: string) => `dav:${userId}:${kind}:${sourceId}`;

async function lockSource(client: DbClient, userId: string, kind: DavCollectionKind, sourceId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key(userId, kind, sourceId)]);
}

/** Lock the credential owner as well as the epoch, so disconnect/configuration
 * changes cannot slip between validation and a projection commit. Sync status
 * updates are deliberately excluded from the revision. */
async function sourceRevision(client: DbClient, userId: string, kind: DavCollectionKind, sourceId: string): Promise<string> {
  const found = await client.query<{ revision: string }>(kind === 'calendar'
    ? `SELECT md5(jsonb_build_array(kind, url, username, password, enabled)::text) AS revision
         FROM calendar_import_sources WHERE id = $1 AND user_id = $2 AND enabled = true FOR SHARE`
    : `SELECT md5(jsonb_build_array(config->'serverUrl', config->'username', config->'password', config->'dupMode', config->'enabled')::text) AS revision
         FROM user_integrations WHERE id = $1 AND user_id = $2 AND provider = 'carddav' AND COALESCE(config->>'enabled', 'true') <> 'false' FOR SHARE`, [sourceId, userId]);
  if (!found.rows[0]) throw new Error('DAV source was removed or disabled');
  return found.rows[0].revision;
}

async function currentFence(client: DbClient, userId: string, kind: DavCollectionKind, sourceId: string, advance = false): Promise<string> {
  const revision = await sourceRevision(client, userId, kind, sourceId);
  const result = await client.query<{ generation: string }>(
    `INSERT INTO dav_source_fences (user_id, kind, source_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, kind, source_id) DO UPDATE SET generation = dav_source_fences.generation + $4::bigint
     RETURNING generation::text`, [userId, kind, sourceId, advance ? 1 : 0]);
  return JSON.stringify([result.rows[0].generation, revision]);
}

export async function captureDavSourceFence(userId: string, kind: DavCollectionKind, sourceId: string): Promise<string> {
  return withTransaction(async client => {
    await lockSource(client, userId, kind, sourceId);
    return currentFence(client, userId, kind, sourceId, true);
  });
}

export async function withDavSourceProjection<T>(userId: string, kind: DavCollectionKind, sourceId: string, generation: string, apply: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async client => {
    await lockSource(client, userId, kind, sourceId);
    if (await currentFence(client, userId, kind, sourceId) !== generation) throw new Error('DAV source snapshot was superseded');
    return apply(client);
  });
}

export async function isDavCollectionBlocked(client: DbClient, userId: string, kind: DavCollectionKind, sourceId: string, remoteUrl: string): Promise<boolean> {
  const found = await client.query(
    `SELECT id FROM dav_collection_operations WHERE user_id = $1 AND kind = $2
       AND source_id = $3 AND remote_fingerprint = $4 AND status <> 'refused'`,
    [userId, kind, sourceId, fingerprint(remoteUrl)]);
  return found.rows.length > 0;
}

/** An authoritative read made with replacement credentials cannot resolve an
 * earlier uncertain DELETE issued through the original credential owner. */
export async function canRetireDavCollection(client: DbClient, userId: string, kind: DavCollectionKind, sourceId: string, remoteUrl: string, localId: string | null = null): Promise<boolean> {
  const pending = await client.query<Operation>(`SELECT * FROM dav_collection_operations
    WHERE user_id = $1 AND kind = $2 AND status IN ('pending', 'confirmed')
      AND (($4::uuid IS NOT NULL AND local_id = $4) OR ($4::uuid IS NULL AND source_id = $3))`,
  [userId, kind, sourceId, localId]);
  if (!pending.rows.length) return true;
  const revision = await sourceRevision(client, userId, kind, sourceId);
  return pending.rows.every(operation => operation.source_id === sourceId
    && operation.source_revision === revision && operation.remote_fingerprint === fingerprint(remoteUrl));
}

/** Delete links first: SET NULL alone would leave enabled collections and remote
 * object identities referring to a projection that no longer exists. Domain FKs
 * cascade events/occurrences/contacts and both downstream DAV resource journals. */
async function cleanupCalendar(client: DbClient, userId: string, sourceId: string): Promise<void> {
  await client.query(`DELETE FROM integration_collections ic USING calendars c
    WHERE ic.local_calendar_id = c.id AND ic.user_id = $1 AND c.user_id = $1
      AND c.owner_user_id = $1 AND c.source = 'caldav' AND c.external_url = $2`, [userId, `source:${sourceId}`]);
  await client.query(`DELETE FROM calendars WHERE user_id = $1 AND owner_user_id = $1
    AND source = 'caldav' AND external_url = $2`, [userId, `source:${sourceId}`]);
  await client.query('DELETE FROM calendar_import_documents WHERE source_id = $1', [sourceId]);
  await client.query(`UPDATE dav_collection_operations SET status = 'completed', updated_at = NOW()
    WHERE user_id = $1 AND kind = 'calendar' AND source_id = $2 AND status IN ('pending', 'confirmed')`, [userId, sourceId]);
  await client.query(`UPDATE calendar_import_sources SET enabled = false, last_error = NULL, updated_at = NOW()
    WHERE id = $1 AND user_id = $2 AND kind = 'caldav'`, [sourceId, userId]);
}

export async function retireDavAddressBook(client: DbClient, userId: string, sourceConnectionId: string, bookId: string): Promise<void> {
  await client.query(`DELETE FROM integration_collections ic USING address_books ab
    WHERE ic.local_address_book_id = ab.id AND ic.user_id = $1 AND ic.source_connection_id = $2
      AND ab.id = $3 AND ab.user_id = $1 AND ab.source_connection_id = $2 AND ab.source = 'carddav'`,
  [userId, sourceConnectionId, bookId]);
  await client.query(`DELETE FROM address_books WHERE id = $3 AND user_id = $1
    AND source_connection_id = $2 AND source = 'carddav'`, [userId, sourceConnectionId, bookId]);
}

export async function retireDavCalendarSource(userId: string, sourceId: string, generation: string): Promise<void> {
  await withDavSourceProjection(userId, 'calendar', sourceId, generation, async client => {
    const source = await client.query<{ url: string }>('SELECT url FROM calendar_import_sources WHERE id = $1 AND user_id = $2', [sourceId, userId]);
    const url = decrypt(source.rows[0]?.url);
    if (!url || !await canRetireDavCollection(client, userId, 'calendar', sourceId, url)) {
      throw new Error('Uncertain DAV deletion requires reconciliation with its original source');
    }
    await cleanupCalendar(client, userId, sourceId);
    await client.query(`UPDATE dav_source_fences SET generation = generation + 1
      WHERE user_id = $1 AND kind = 'calendar' AND source_id = $2`, [userId, sourceId]);
  });
}

async function bindingFor(client: DbClient, userId: string, kind: DavCollectionKind, localId: string): Promise<Binding | null> {
  if (kind === 'calendar') {
    const result = await client.query<Binding>(`SELECT s.id AS source_id, s.url, s.username, s.password,
      s.url AS server_url, ic.user_access
      FROM calendars c JOIN calendar_import_sources s ON c.external_url = 'source:' || s.id::text
      LEFT JOIN integration_collections ic ON ic.local_calendar_id = c.id AND ic.user_id = c.user_id
      WHERE c.id = $1 AND c.user_id = $2 AND c.owner_user_id = $2 AND c.source = 'caldav'
        AND s.user_id = $2 AND s.kind = 'caldav' AND s.enabled = true`, [localId, userId]);
    const binding = result.rows[0];
    if (!binding) return null;
    const url = decrypt(binding.url);
    const password = decrypt(binding.password ?? '');
    if (!url || !password) throw new Error('DAV source credentials are unavailable');
    return { ...binding, url: resolveDavHref(url, url), server_url: url, password };
  }
  const result = await client.query<Binding>(`SELECT s.id AS source_id, ab.external_url AS url,
    s.config->>'serverUrl' AS server_url, s.config->>'username' AS username, s.config->>'password' AS password, ic.user_access
    FROM address_books ab JOIN source_connections sc ON sc.id = ab.source_connection_id AND sc.user_id = ab.user_id
    JOIN user_integrations s ON s.id = sc.integration_id AND s.user_id = sc.user_id AND s.provider = 'carddav'
    LEFT JOIN integration_collections ic ON ic.local_address_book_id = ab.id AND ic.source_connection_id = sc.id AND ic.user_id = ab.user_id
    WHERE ab.id = $1 AND ab.user_id = $2 AND ab.source = 'carddav' AND sc.kind = 'carddav' AND sc.enabled = true`, [localId, userId]);
  const binding = result.rows[0];
  if (!binding) return null;
  const password = decrypt(binding.password ?? '');
  if (!password || !binding.server_url || !binding.username) throw new Error('DAV source credentials are unavailable');
  return { ...binding, url: resolveDavHref(binding.url, binding.server_url), password };
}

export async function getRemoteDavCollectionDeleteCapability(userId: string, kind: DavCollectionKind, localId: string): Promise<{ allowed: boolean; reason: string }> {
  const binding = await bindingFor({ query }, userId, kind, localId);
  if (!binding) return { allowed: false, reason: 'Owned DAV collection binding not found' };
  if (binding.user_access === 'read_only') return { allowed: false, reason: 'Collection is configured read-only' };
  const policy = await getConnectionPolicy();
  return discoverDavCollectionDeleteCapability({ ...binding, kind, allowPrivate: policy.allowPrivateHosts });
}

async function deleteRemoteCollection(userId: string, kind: DavCollectionKind, localId: string): Promise<DavCollectionDeleteResult> {
  const previous = await query<Operation>('SELECT * FROM dav_collection_operations WHERE user_id = $1 AND kind = $2 AND local_id = $3', [userId, kind, localId]);
  if (previous.rows[0]?.status === 'completed') return { status: 'deleted', operationId: previous.rows[0].id };
  const binding = await bindingFor({ query }, userId, kind, localId);
  if (!binding) return { status: 'not_found', reason: 'Owned DAV collection binding not found' };
  if (binding.user_access === 'read_only' && !previous.rows[0]) return { status: 'refused', reason: 'Collection is configured read-only' };
  const operation = await withTransaction(async client => {
    await lockSource(client, userId, kind, binding.source_id);
    const revision = await sourceRevision(client, userId, kind, binding.source_id);
    const current = await bindingFor(client, userId, kind, localId);
    if (!current || current.source_id !== binding.source_id || fingerprint(current.url) !== fingerprint(binding.url)
        || current.password !== binding.password || current.username !== binding.username) throw new Error('DAV collection binding changed');
    const existing = await client.query<Operation>('SELECT * FROM dav_collection_operations WHERE user_id = $1 AND kind = $2 AND local_id = $3 FOR UPDATE', [userId, kind, localId]);
    if (existing.rows[0] && existing.rows[0].status !== 'refused') return { row: existing.rows[0], dispatch: false, revision };
    if (current.user_access === 'read_only') return null;
    // Commit a conservative pending record BEFORE any remote side effect. This
    // is also the fence for readers already waiting on remote HTTP responses.
    await client.query(`INSERT INTO dav_source_fences (user_id, kind, source_id) VALUES ($1,$2,$3)
      ON CONFLICT (user_id, kind, source_id) DO UPDATE SET generation = dav_source_fences.generation + 1`, [userId, kind, binding.source_id]);
    const inserted = await client.query<Operation>(`INSERT INTO dav_collection_operations
      (user_id, kind, source_id, local_id, remote_fingerprint, source_revision, status)
      VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (user_id, kind, local_id) DO UPDATE
      SET status = 'pending', source_id = EXCLUDED.source_id, remote_fingerprint = EXCLUDED.remote_fingerprint,
          source_revision = EXCLUDED.source_revision, reason = NULL, updated_at = NOW() RETURNING *`,
    [userId, kind, binding.source_id, localId, fingerprint(binding.url), revision]);
    return { row: inserted.rows[0], dispatch: true, revision };
  });
  if (!operation) return { status: 'refused', reason: 'Collection is configured read-only' };
  const { row } = operation;
  const operationId = row.id;
  if (row.source_id !== binding.source_id || row.remote_fingerprint !== fingerprint(binding.url) || row.source_revision !== operation.revision) {
    return { status: 'unknown', operationId, reason: 'Source changed since deletion; reconciliation requires the original source' };
  }
  if (row.status === 'completed') return { status: 'deleted', operationId };
  const policy = await getConnectionPolicy();
  const input = { ...binding, kind, allowPrivate: policy.allowPrivateHosts };
  let confirmed = row.status === 'confirmed';
  if (!confirmed) {
    if (operation.dispatch) {
      const result = await deleteDavCollection(input);
      if (result.status === 'refused') {
        await query(`UPDATE dav_collection_operations SET status = 'refused', reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [operationId, result.reason ?? 'Provider refused collection deletion']);
        return { status: 'refused', operationId, reason: result.reason };
      }
      confirmed = result.status === 'confirmed';
    } else {
      confirmed = await inspectDavCollection(input) === 'missing';
    }
    if (!confirmed) return { status: 'unknown', operationId, reason: 'Remote collection deletion is not confirmed; retry checks its state without repeating DELETE' };
    await query(`UPDATE dav_collection_operations SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [operationId]);
  }
  // A crash between confirmed remote deletion and this transaction is recoverable
  // from the journal; cleanup is idempotent and the blocked identity stays durable.
  return withTransaction(async client => {
    await lockSource(client, userId, kind, binding.source_id);
    const journal = await client.query<Operation>('SELECT * FROM dav_collection_operations WHERE id = $1 FOR UPDATE', [operationId]);
    if (journal.rows[0]?.status === 'completed') return { status: 'deleted', operationId };
    if (journal.rows[0]?.status !== 'confirmed') return { status: 'unknown', operationId };
    if (await sourceRevision(client, userId, kind, binding.source_id) !== row.source_revision) return { status: 'unknown', operationId, reason: 'Source changed before local cleanup' };
    if (kind === 'calendar') await cleanupCalendar(client, userId, binding.source_id);
    else {
      const owner = await client.query<{ id: string }>(`SELECT sc.id FROM source_connections sc JOIN user_integrations s ON s.id = sc.integration_id
        WHERE sc.user_id = $1 AND s.user_id = $1 AND sc.kind = 'carddav' AND s.provider = 'carddav' AND s.id = $2`, [userId, binding.source_id]);
      if (!owner.rows[0]) return { status: 'unknown', operationId, reason: 'Source disconnected before cleanup' };
      await retireDavAddressBook(client, userId, owner.rows[0].id, localId);
    }
    await client.query(`UPDATE dav_collection_operations SET status = 'completed', updated_at = NOW() WHERE id = $1 AND status = 'confirmed'`, [operationId]);
    return { status: 'deleted', operationId };
  });
}

export function deleteRemoteDavCalendarCollection(userId: string, calendarId: string): Promise<DavCollectionDeleteResult> {
  return deleteRemoteCollection(userId, 'calendar', calendarId);
}
export function deleteRemoteDavAddressBookCollection(userId: string, bookId: string): Promise<DavCollectionDeleteResult> {
  return deleteRemoteCollection(userId, 'addressbook', bookId);
}
