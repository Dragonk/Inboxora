import type { PoolClient } from 'pg';
import { query, withSavepoint, withTransaction } from '../../db.js';
import { toAppError } from '../../../utils/errors.js';
import { ProviderAuthError } from '../../providerAuthService.js';
import {
  acquireSyncLease,
  commitSyncCheckpoint,
  ensureSyncState,
  failSyncRun,
  finishSyncRun,
  readSyncState,
  releaseSyncLease,
  SyncLeaseLostError,
  withFencedSyncLease,
} from '../../syncCoordinator.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import {
  fetchMailFolderSnapshot,
  fetchWellKnownFolderIds,
  fetchMessagesDeltaPage,
  graphFolderPathMap,
  localMessageForGraphMessage,
  providerUidForGraphMessage,
} from './graphMail.js';
import type { GraphMessage, LocalMailFolder } from './graphMail.js';
import { drainGraphMailFlagOperations } from './graphMailMutations.js';
import { applyIngestRulesToRows } from '../../providerIngestRules.js';
import { persistConversationCopyForRow } from '../../conversationRowIngest.js';
import { immutableIdsEnabled } from './graphMessageIdType.js';
import type { ConversationAccountRow } from '../../conversationRowIngest.js';
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
/**
 * The mailboxes a connection's sync should cover.
 *
 * The account is matched by its own link **or** by the connection's verified identity, because an identity can
 * have more than one connection row: the one its cutover created and the one a consent stored scopes on. The
 * features are read through the account's link, while the scheduler walks the connection that holds the
 * collections — and requiring the account's link to equal *that* id returned nothing at all, which is how a
 * native mailbox reported as connected stopped fetching mail entirely ("total silence" with no error, because
 * there was no account to synchronise).
 */
export async function listGraphMailAccounts(client: PoolClient, input: { userId: string; connectionId: string }): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT a.id FROM email_accounts a
      WHERE a.user_id = $1 AND a.mail_transport = 'microsoft_graph'
        AND (
          a.provider_connection_id = $2
          OR lower(a.email_address) = lower(COALESCE((
            SELECT c.provider_user_id FROM provider_connections c WHERE c.id = $2 AND c.user_id = $1
          ), ''))
        )
      ORDER BY a.created_at ASC`,
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
  options: { complete?: boolean } = {},
): Promise<{ created: number; updated: number; renamed: number; relocatedMessages: number; retracted: number }> {
  const totals = { created: 0, updated: 0, renamed: 0, relocatedMessages: 0, retracted: 0 };
  for (const [remoteId, local] of folders) {
    const applied = await applyFolder(client, context, remoteId, local);
    if (applied.outcome === 'created') totals.created += 1;
    else totals.updated += 1;
    if (applied.renamed) totals.renamed += 1;
    totals.relocatedMessages += applied.movedMessages;
  }
  // A **complete** snapshot is authoritative, so a folder it does not list no longer exists at the provider.
  // Its link is retracted rather than left as a target: a stale target kept being synced and answered 404,
  // which ended the whole account's run (GRAPH-06). The local folder and its messages are kept — deleting them
  // here would be destructive on the strength of a snapshot that could be wrong, and a message that moved is
  // re-homed by the destination folder's own delta, which is the authority on where it now lives.
  if (options.complete !== false) {
    const remoteIds = [...folders.keys()];
    const retracted = await client.query(
      `UPDATE integration_collections
          SET enabled = false, updated_at = NOW()
        WHERE user_id = $1 AND connection_id = $2 AND account_id = $3 AND kind = 'mail_folder'
          AND enabled = true AND remote_id <> ALL($4::text[])
        RETURNING id`,
      [context.userId, context.connectionId, context.accountId, remoteIds],
    );
    totals.retracted = retracted.rowCount ?? retracted.rows.length;
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
      code: 'SYNC_ALREADY_RUNNING',
      message: 'Another Microsoft mail folder sync is already running for this account',
      status: 409,
      retryable: true,
    });
  }

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner,
    // GRAPH-04: the immutable-id preference is only used for a mailbox whose stored ids have already been
    // translated into that form; read here, from the connection's own record, never assumed.
    immutableIds: await immutableIdsEnabled(input.connectionId),
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const context: FolderContext = {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
  };

  try {
    // The listing carries no role: `wellKnownName` is a beta-only property and requesting it from v1.0 can fail
    // the whole request (GRAPH-01). Roles come from resolving each well-known alias to its real id instead. The
    // snapshot's completeness decides whether a folder that is absent may be retracted (GRAPH-06).
    const [snapshot, wellKnownById] = await Promise.all([
      fetchMailFolderSnapshot(api),
      fetchWellKnownFolderIds(api),
    ]);
    const mapped = graphFolderPathMap(snapshot.folders, wellKnownById);
    const applied = await withFencedSyncLease({ syncStateId, generation: lease.generation, run: client => applyGraphMailFolders(client, context, mapped, { complete: snapshot.complete }) });
    const committed = await withTransaction(async client => {
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      // The folder snapshot is the whole declared scope of this run (SYNC-02).
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
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
    // `ProviderAuthError` is not a `GraphApiError`, and a token or grant problem is the most common reason a
    // provider sync fails. Classifying it as INTERNAL_ERROR hid the one instruction that helps — reconnect or
    // grant the scope — so the authorization failures are reported by their own code, as the calendar and
    // contacts syncs already did.
    const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * Microsoft Graph **message metadata** sync (P07b, second slice).
 *
 * One delta cursor per folder collection in `sync_states`, so a later run reads
 * only what changed. Identity is the provider's immutable message id
 * (`messages.provider_message_id`, migration `0108`), never the RFC `Message-ID`
 * and never a hash of it; `uid` is derived so the column's legacy
 * `UNIQUE (account_id, uid, folder)` stays meaningful.
 *
 * Two rules are inherited deliberately from the IMAP path rather than invented:
 * the `*_changed_at` local-wins window, so a flag the user just changed is not
 * reverted by a sync that read the server before the change landed; and a delta
 * token Graph rejects (`410`) rebuilding the folder from a baseline **and
 * reconciling**, because a plain re-read would miss whatever was deleted while the
 * cursor was unusable.
 *
 * Not yet here: body, attachments and message mutations. This slice brings the
 * message list — subject, correspondents, date, snippet, flags, thread — into the
 * local model, which is what the interface lists.
 */


export interface GraphMailMessageSyncResult {
  accountId: string;
  folders: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSyncFolders: number;
  /** Folders whose delta did not reach its end within one run, so their snapshot is only a prefix (SYNC-04). */
  incompleteFolders: number;
  /** Folders that could not be synchronised at all this run; the others still were (GRAPH-06). */
  failedFolders: number;
}

/** One folder's outcome, so a caller can tell a baseline from an incremental run. */
interface FolderMessageSyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  fullSync: boolean;
  /** The delta did not reach its end within one run; the local snapshot is a prefix, not the folder (SYNC-04). */
  incomplete: boolean;
}

/** The local folder a mail-folder collection projects onto. */
interface FolderTarget {
  collectionId: string;
  remoteId: string;
  folderPath: string;
}

interface MessageContext {
  userId: string;
  accountId: string;
  folderPath: string;
}

const MESSAGE_MAX_PAGES = 1000;
/** The local-wins window the IMAP path uses, in seconds. */
const LOCAL_WINS_SECONDS = 30;

/**
 * Upsert one page of messages.
 *
 * The `ON CONFLICT` target is the partial provider-identity index: an identical
 * message is updated in place, so re-reading the same page changes nothing. A `uid`
 * collision — astronomically unlikely, and possible only between two *different*
 * provider ids — is resolved by asking for the next derived number instead of
 * failing the page.
 */
export async function applyGraphMailMessagesPage(
  client: PoolClient,
  context: MessageContext,
  messages: readonly GraphMessage[],
  seenProviderIds?: Set<string>,
): Promise<{ created: number; updated: number; deleted: number; skipped: number; rowIds: string[] }> {
  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0, rowIds: [] as string[] };
  for (const message of messages) {
    if (!message.id) { totals.skipped += 1; continue; }
    if (message['@removed']) {
      // The delta is folder-scoped, and Graph emits `@removed` both for a real deletion and for a message that
      // *moved out of this folder*. Deleting by account and provider id alone therefore removed a message that
      // had already been re-homed to the destination folder — the folder the delta was read from is the one that
      // may be vacated, so the deletion is scoped to it (GRAPH-05). A move processed in either order now
      // converges on one row in the destination: source-first deletes it and the destination re-creates it,
      // destination-first leaves it untouched because its folder no longer matches.
      const removed = await client.query(
        'DELETE FROM messages WHERE account_id = $1 AND provider_message_id = $2 AND folder = $3',
        [context.accountId, message.id, context.folderPath],
      );
      if ((removed.rowCount ?? 0) > 0) totals.deleted += 1;
      else totals.skipped += 1;
      continue;
    }
    const local = localMessageForGraphMessage(message);
    if (!local) { totals.skipped += 1; continue; }
    seenProviderIds?.add(local.providerMessageId);

    let applied: { id: string; inserted: boolean } | null = null;
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      const uid = attempt === 0 ? local.uid : providerUidForGraphMessage(local.providerMessageId, attempt);
      try {
        // The legacy (account_id, uid, folder) index can reject the derived number, and a failed statement
        // aborts the transaction; the savepoint is what lets the next attempt run at all (DB-01).
        applied = await withSavepoint(client, `graph_uid_${attempt}`, async () => {
          const result = await client.query<{ id: string; inserted: boolean }>(
            `INSERT INTO messages (
               account_id, uid, folder, provider_message_id, message_id, thread_id, subject, from_name, from_email,
               to_addresses, cc_addresses, reply_to, date, snippet, is_read, is_starred, has_attachments, synced_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,NOW())
             ON CONFLICT (account_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO UPDATE SET
               folder = EXCLUDED.folder,
               uid = EXCLUDED.uid,
               message_id = EXCLUDED.message_id,
               thread_id = EXCLUDED.thread_id,
               subject = EXCLUDED.subject,
               from_name = EXCLUDED.from_name,
               from_email = EXCLUDED.from_email,
               to_addresses = EXCLUDED.to_addresses,
               cc_addresses = EXCLUDED.cc_addresses,
               reply_to = EXCLUDED.reply_to,
               date = EXCLUDED.date,
               snippet = EXCLUDED.snippet,
               is_read = CASE
                 WHEN messages.read_changed_at IS NULL OR messages.read_changed_at < NOW() - make_interval(secs => $18)
                   THEN EXCLUDED.is_read ELSE messages.is_read END,
               is_starred = CASE
                 WHEN messages.star_changed_at IS NULL OR messages.star_changed_at < NOW() - make_interval(secs => $18)
                   THEN EXCLUDED.is_starred ELSE messages.is_starred END,
               has_attachments = EXCLUDED.has_attachments,
               synced_at = NOW()
             RETURNING id, (xmax = 0) AS inserted`,
            [
              context.accountId, uid, context.folderPath, local.providerMessageId, local.messageId, local.threadId,
              local.subject, local.fromName, local.fromEmail,
              JSON.stringify(local.toAddresses), JSON.stringify(local.ccAddresses), JSON.stringify(local.replyTo),
              local.date, local.snippet, local.isRead, local.isStarred, local.hasAttachments, LOCAL_WINS_SECONDS,
            ],
          );
          return result.rows[0] ?? null;
        });
        if (applied) {
          await client.query('UPDATE messages SET parsed_headers = $2::jsonb WHERE id = $1', [
            applied.id,
            JSON.stringify(local.parsedHeaders),
          ]);
          // The id is collected so the caller can run the conversation projection
          // **after** this transaction commits: the engine opens its own, and nesting
          // the two is the mistake this return value exists to prevent.
          totals.rowIds.push(applied.id);
          if (applied.inserted) totals.created += 1;
          else totals.updated += 1;
        }
      } catch (caught) {
        // 23505 here is the legacy (account_id, uid, folder) index: another message
        // already owns this derived number, so ask for the next one.
        if (toAppError(caught).code === '23505') continue;
        throw caught;
      }
    }
    if (!applied) totals.skipped += 1;
  }
  return totals;
}

/** Remove the local provider messages of a folder that a rebuilt baseline did not list. */
export async function reconcileGraphMailMessages(
  client: PoolClient,
  context: MessageContext,
  seenProviderIds: ReadonlySet<string>,
): Promise<number> {
  const removed = await client.query(
    `DELETE FROM messages
      WHERE account_id = $1 AND folder = $2 AND provider_message_id IS NOT NULL
        AND provider_message_id <> ALL($3::text[])`,
    [context.accountId, context.folderPath, [...seenProviderIds]],
  );
  return removed.rowCount ?? 0;
}

/** The enabled mail-folder collections of one connection, with their local paths. */
export async function listGraphFolderTargets(client: PoolClient, input: { connectionId: string; accountId: string }): Promise<FolderTarget[]> {
  const result = await client.query<{ collection_id: string; remote_id: string; path: string }>(
    `SELECT ic.id AS collection_id, ic.remote_id, f.path
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_folder' AND ic.enabled = true
      ORDER BY ic.remote_id`,
    [input.connectionId, input.accountId],
  );
  return result.rows.map(row => ({ collectionId: row.collection_id, remoteId: row.remote_id, folderPath: row.path }));
}


/**
 * Project the messages a page wrote into the conversation engine.
 *
 * Called **after** the page's transaction commits — the engine opens its own — and one
 * row at a time so a single failure is recorded against that row by the shared
 * function rather than aborting the sync. The body of a Graph message is not needed
 * here: delivery and provider metadata come from the persisted row, which is what the
 * ingest paths share.
 *
 * Exported because provider-side search writes rows through the same projection and
 * must run the same post-commit step, rather than a second copy of it.
 */
export async function persistConversations(rowIds: readonly string[], account: ConversationAccountRow): Promise<void> {
  for (const rowId of rowIds) {
    await persistConversationCopyForRow(rowId, account, null).catch(error =>
      console.warn(`Graph conversation projection failed for ${rowId}:`, error instanceof Error ? error.message : error));
  }
}

/**
 * Sync the messages of every discovered folder of one Graph mail account.
 *
 * Folder discovery must have run first: a folder with no collection and no local
 * path has no cursor to keep and no `messages.folder` value to write.
 */
export async function syncGraphMailMessagesForAccount(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  owner?: string;
  /** The page cap for one folder's delta; injectable so the "limited run is not complete" path is provable. */
  maxPages?: number;
}): Promise<GraphMailMessageSyncResult> {
  // Settle any flag mutation the journal scheduled before reading the delta: a
  // pending write would otherwise be overwritten by the very sync that is about to
  // read the provider's older state.
  const drained = await drainGraphMailFlagOperations({
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (drained.unresolved > 0) {
    console.warn(`Graph mail: ${drained.unresolved} scheduled flag mutation(s) still unresolved for account ${input.accountId}`);
  }

  // Loaded once, for the conversation projection: the folder-level function would
  // otherwise query it per folder, and the projection needs the transport and host to
  // derive the provider identity.
  const accountResult = await query<ConversationAccountRow>(
    'SELECT id, user_id, imap_host, mail_transport, provider_connection_id, folder_mappings FROM email_accounts WHERE id = $1',
    [input.accountId],
  );
  const account = accountResult.rows[0];
  if (!account) return { accountId: input.accountId, folders: 0, created: 0, updated: 0, deleted: 0, skipped: 0, fullSyncFolders: 0, incompleteFolders: 0, failedFolders: 0 };

  const targets = await withTransaction(client => listGraphFolderTargets(client, input));
  const totals: GraphMailMessageSyncResult = {
    accountId: input.accountId, folders: 0, created: 0, updated: 0, deleted: 0, skipped: 0, fullSyncFolders: 0, incompleteFolders: 0, failedFolders: 0,
  };

  for (const target of targets) {
    try {
      const result = await syncGraphMailMessagesForFolder({ ...input, account, target });
      totals.folders += 1;
      totals.created += result.created;
      totals.updated += result.updated;
      totals.deleted += result.deleted;
      totals.skipped += result.skipped;
      if (result.fullSync) totals.fullSyncFolders += 1;
      if (result.incomplete) totals.incompleteFolders += 1;
    } catch (caught) {
      const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError
        ? caught.code : 'INTERNAL_ERROR';
      // One unusable folder must not end the whole mailbox's run (GRAPH-06), but an error that says the *run*
      // or the *connection* is over must still stop it: a lost lease means another worker owns the collection,
      // and a revoked grant or missing scope is not one folder's problem.
      const fatal = caught instanceof SyncLeaseLostError
        || caught instanceof ProviderAuthError
        || (caught instanceof GraphApiError && (caught.code === 'PROVIDER_AUTH_REQUIRED' || caught.code === 'INSUFFICIENT_SCOPES'));
      if (fatal) throw caught;

      totals.failedFolders += 1;
      console.warn(`Graph mail: folder ${target.remoteId} could not be synchronised (${code}):`, caught instanceof Error ? caught.message : caught);
      // A folder the provider no longer has (404) is retracted from the targets so the next discovery drops
      // it, instead of failing the same way on every run.
      if (caught instanceof GraphApiError && caught.code === 'RESOURCE_NOT_FOUND') {
        await withTransaction(client => client.query(
          `UPDATE integration_collections SET enabled = false, updated_at = NOW()
            WHERE id = $1 AND user_id = $2`,
          [target.collectionId, input.userId],
        )).catch(() => { /* the run's other folders are what matter here */ });
      }
    }
  }
  return totals;
}

/** Sync one folder collection under the P03 lease that owns its delta cursor. */
export async function syncGraphMailMessagesForFolder(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  /** Loaded once by the account-level caller; the conversation projection needs it. */
  account: ConversationAccountRow;
  target: FolderTarget;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  owner?: string;
  /** The page cap for this folder's delta; see the account-level input. */
  maxPages?: number;
}): Promise<FolderMessageSyncResult> {
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    feature: 'mail',
    collectionId: input.target.collectionId,
    coverage: 'messages',
  }));

  const owner = input.owner ?? `graph-mail-messages:${input.target.collectionId}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GraphApiError({
      code: 'SYNC_ALREADY_RUNNING',
      message: `Another Microsoft message sync is already running for folder ${input.target.remoteId}`,
      status: 409,
      retryable: true,
    });
  }

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner,
    immutableIds: await immutableIdsEnabled(input.connectionId),
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const context: MessageContext = { userId: input.userId, accountId: input.accountId, folderPath: input.target.folderPath };

  try {
    const state = await withTransaction(client => readSyncState(client, syncStateId));
    let cursor = state?.cursor ?? null;
    let fullSync = cursor === null;
    let nextLink: string | null = null;
    // Only a baseline needs the seen-set: a delta reports deletions explicitly.
    const seen = new Set<string>();
    const totals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
    let complete = false;

    for (let page = 0; page < (input.maxPages ?? MESSAGE_MAX_PAGES); page++) {
      let fetched;
      try {
        fetched = await fetchMessagesDeltaPage(api, {
          folderId: input.target.remoteId,
          nextLink,
          deltaLink: nextLink ? null : cursor,
        });
      } catch (caught) {
        // An expired delta token: rebuild this folder from a baseline instead of failing.
        if (caught instanceof GraphApiError && caught.code === 'INVALID_SYNC_CURSOR' && cursor) {
          cursor = null;
          nextLink = null;
          fullSync = true;
          seen.clear();
          continue;
        }
        throw caught;
      }
      const applied = await withFencedSyncLease({ syncStateId, generation: lease.generation, run: client => applyGraphMailMessagesPage(client, context, fetched.messages, seen) });
      await persistConversations(applied.rowIds, input.account);
      // MAIL-01: a blocked sender's mail must not stay in a native account's inbox either. The block list
      // runs on the rows this page just stored, through the provider port, and only for a folder that is the
      // account's inbox.
      await applyIngestRulesToRows({
        userId: input.userId,
        connectionId: input.connectionId,
        account: input.account,
        folder: input.target.folderPath,
        rowIds: applied.rowIds,
        providerName: 'Microsoft Graph',
      }).catch((error: unknown) => console.warn('Microsoft Graph ingest block list failed:', error instanceof Error ? error.message : error));
      totals.created += applied.created;
      totals.updated += applied.updated;
      totals.deleted += applied.deleted;
      totals.skipped += applied.skipped;
      if (fetched.deltaLink) cursor = fetched.deltaLink;
      nextLink = fetched.nextLink;
      if (!nextLink) { complete = true; break; }
    }

    if (!complete) {
      // The page cap was reached before the delta ended, so `seen` (and the local snapshot) is only a prefix.
      // Reconciling deletions against a prefix would delete messages that simply had not been read yet, and
      // storing a cursor would skip everything after the cap for ever (SYNC-04). The stored cursor is left
      // untouched and the run does not claim a successful synchronisation.
      await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
      return { ...totals, fullSync, incomplete: true };
    }

    if (fullSync) {
      // A baseline lists everything that still exists, so anything else is gone.
      totals.deleted += await withFencedSyncLease({ syncStateId, generation: lease.generation, run: client => reconcileGraphMailMessages(client, context, seen) });
    }

    const committed = await withTransaction(async client => {
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        cursor,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      // The delta was read to its end, so the run may claim a successful synchronisation (SYNC-02).
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
    if (!committed) {
      throw new GraphApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the delta cursor could be stored',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return { ...totals, fullSync, incomplete: false };
  } catch (caught) {
    // `ProviderAuthError` is not a `GraphApiError`, and a token or grant problem is the most common reason a
    // provider sync fails. Classifying it as INTERNAL_ERROR hid the one instruction that helps — reconnect or
    // grant the scope — so the authorization failures are reported by their own code, as the calendar and
    // contacts syncs already did.
    const code = caught instanceof GraphApiError || caught instanceof ProviderAuthError || caught instanceof SyncLeaseLostError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * The provider folder id a local path projects from.
 *
 * A move addresses the destination by the provider's folder id, and everything
 * above this layer addresses a folder by its local path, so the link the folder
 * slice created (`integration_collections.local_folder_id` ↔ `remote_id`) is read
 * backwards here. `null` means the path is not a folder this connection discovered,
 * which is a refusal rather than an invitation to guess.
 */
export async function graphFolderIdForPath(input: { connectionId: string; accountId: string; path: string }): Promise<string | null> {
  const result = await query<{ remote_id: string }>(
    `SELECT ic.remote_id
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_folder' AND f.path = $3
      LIMIT 1`,
    [input.connectionId, input.accountId, input.path],
  );
  return result.rows[0]?.remote_id ?? null;
}
