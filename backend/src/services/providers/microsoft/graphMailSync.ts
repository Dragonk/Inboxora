import type { PoolClient } from 'pg';
import { withTransaction } from '../../db.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  releaseSyncLease,
} from '../../syncCoordinator.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { fetchMailFolders, graphFolderPathMap } from './graphMail.js';
import type { LocalMailFolder } from './graphMail.js';
import type { FetchLike } from '../../providerAuthService.js';

/**
 * Microsoft Graph mail **folder discovery** (P07b).
 *
 * The first step of the Graph mail vertical: a connected mailbox's folder tree
 * becomes the local `folders` rows the rest of the application already reads, and
 * each folder is linked to its Graph id through `integration_collections`, so a
 * later message sync has somewhere to put its cursor and a rename is recognised as
 * a rename.
 *
 * A folder listing is a full snapshot rather than a delta — Graph's folder delta
 * carries the same five-minute reconciliation caveat as the message one, and a
 * folder tree is small enough that a snapshot is the simpler correct answer. The
 * run still takes the P03 sync lease, so two passes cannot interleave.
 *
 * When a folder's derived path changes, the messages stored under the old path are
 * moved with it. Skipping that would orphan every message in a renamed folder —
 * they would stay in the table under a path no folder owns, which is exactly the
 * silent-loss shape this work has been correcting.
 */

export interface GraphMailFolderSyncResult {
  accountId: string;
  /** Folders in the provider's tree. */
  folders: number;
  created: number;
  updated: number;
  renamed: number;
  /** Messages re-homed because their folder was renamed. */
  relocatedMessages: number;
}

interface FolderContext {
  userId: string;
  connectionId: string;
  accountId: string;
}

/** The Graph mail accounts of one connection belong to a single owner. */
export async function listGraphMailAccounts(client: PoolClient, input: { userId: string; connectionId: string }): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM email_accounts
      WHERE user_id = $1 AND provider_connection_id = $2 AND mail_transport = 'microsoft_graph'
      ORDER BY created_at ASC`,
    [input.userId, input.connectionId],
  );
  return result.rows.map(row => row.id);
}

/** Find or create the local folder a Graph folder projects onto, and link it. */
async function applyFolder(client: PoolClient, context: FolderContext, remoteId: string, local: LocalMailFolder): Promise<{
  outcome: 'created' | 'updated';
  renamed: boolean;
  movedMessages: number;
  folderId: string;
}> {
  const link = await client.query<{ id: string; local_folder_id: string | null }>(
    `SELECT id, local_folder_id FROM integration_collections
      WHERE connection_id = $1 AND kind = 'mail_folder' AND remote_id = $2`,
    [context.connectionId, remoteId],
  );

  let folderId = link.rows[0]?.local_folder_id ?? null;
  let previousPath: string | null = null;
  if (folderId) {
    const current = await client.query<{ path: string }>(
      'SELECT path FROM folders WHERE id = $1 AND account_id = $2',
      [folderId, context.accountId],
    );
    // A folder deleted locally is recreated from the source on the next run.
    if (current.rows[0]) previousPath = current.rows[0].path;
    else folderId = null;
  }

  const outcome: 'created' | 'updated' = folderId ? 'updated' : 'created';
  let movedMessages = 0;
  if (folderId) {
    await client.query(
      `UPDATE folders
          SET name = $2, delimiter = $3, special_use = $4, total_count = $5, unread_count = $6, updated_at = NOW()
        WHERE id = $1`,
      [folderId, local.name, local.delimiter, local.specialUse, local.totalCount, local.unreadCount],
    );
    if (previousPath !== null && previousPath !== local.path) {
      // A path conflict means another folder now owns the new path; resolve it by
      // taking the path over rather than failing the whole run.
      await client.query('DELETE FROM folders WHERE account_id = $1 AND path = $2 AND id <> $3', [context.accountId, local.path, folderId]);
      await client.query('UPDATE folders SET path = $2, updated_at = NOW() WHERE id = $1', [folderId, local.path]);
      const moved = await client.query('UPDATE messages SET folder = $2 WHERE account_id = $1 AND folder = $3', [context.accountId, local.path, previousPath]);
      movedMessages = moved.rowCount ?? 0;
    }
  } else {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO folders (account_id, path, name, delimiter, special_use, total_count, unread_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, path) DO UPDATE SET
         name = EXCLUDED.name, delimiter = EXCLUDED.delimiter, special_use = EXCLUDED.special_use,
         total_count = EXCLUDED.total_count, unread_count = EXCLUDED.unread_count, updated_at = NOW()
       RETURNING id`,
      [context.accountId, local.path, local.name, local.delimiter, local.specialUse, local.totalCount, local.unreadCount],
    );
    folderId = inserted.rows[0]?.id ?? null;
    if (!folderId) throw new Error('Could not create the Microsoft mail folder');
  }

  if (link.rows[0]) {
    await client.query(
      'UPDATE integration_collections SET local_folder_id = $2, updated_at = NOW() WHERE id = $1',
      [link.rows[0].id, folderId],
    );
  } else {
    await client.query(
      `INSERT INTO integration_collections
         (user_id, connection_id, account_id, kind, remote_id, local_folder_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1,$2,$3,'mail_folder',$4,$5,true,'read_only','source','off')
       ON CONFLICT DO NOTHING`,
      [context.userId, context.connectionId, context.accountId, remoteId, folderId],
    );
  }

  return { outcome, renamed: previousPath !== null && previousPath !== local.path, movedMessages, folderId };
}

/** Apply a whole folder snapshot for one account inside one transaction. */
export async function applyGraphMailFolders(
  client: PoolClient,
  context: FolderContext,
  folders: ReadonlyMap<string, LocalMailFolder>,
): Promise<{ created: number; updated: number; renamed: number; relocatedMessages: number }> {
  const totals = { created: 0, updated: 0, renamed: 0, relocatedMessages: 0 };
  for (const [remoteId, local] of folders) {
    const applied = await applyFolder(client, context, remoteId, local);
    if (applied.outcome === 'created') totals.created += 1;
    else totals.updated += 1;
    if (applied.renamed) totals.renamed += 1;
    totals.relocatedMessages += applied.movedMessages;
  }
  return totals;
}

/**
 * Discover the mail folders of every Graph account on one connection.
 *
 * A connection with no Graph mail account is a no-op rather than an error: the
 * provider connection exists for calendars or contacts too.
 */
export async function syncGraphMailFolders(input: {
  userId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  owner?: string;
}): Promise<GraphMailFolderSyncResult[]> {
  const accountIds = await withTransaction(client => listGraphMailAccounts(client, {
    userId: input.userId,
    connectionId: input.connectionId,
  }));

  const results: GraphMailFolderSyncResult[] = [];
  for (const accountId of accountIds) {
    results.push(await syncGraphMailFoldersForAccount({ ...input, accountId }));
  }
  return results;
}

/** Discover the folders of one Graph mail account under the P03 sync lease. */
export async function syncGraphMailFoldersForAccount(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  owner?: string;
}): Promise<GraphMailFolderSyncResult> {
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    feature: 'mail',
    coverage: 'folders',
  }));

  const owner = input.owner ?? `graph-mail-folders:${input.accountId}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GraphApiError({
      code: 'RATE_LIMITED',
      message: 'Another Microsoft mail folder sync is already running for this account',
      status: 409,
      retryable: true,
    });
  }

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const context: FolderContext = {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
  };

  try {
    const folders = await fetchMailFolders(api);
    const mapped = graphFolderPathMap(folders);
    const applied = await withTransaction(client => applyGraphMailFolders(client, context, mapped));
    const committed = await withTransaction(client => commitSyncCheckpoint(client, {
      syncStateId,
      generation: lease.generation,
      clearPageCheckpoint: true,
      lastErrorCode: null,
    }));
    if (!committed) {
      throw new GraphApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the folder snapshot could be recorded',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return { accountId: input.accountId, folders: mapped.size, ...applied };
  } catch (caught) {
    const code = caught instanceof GraphApiError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}
