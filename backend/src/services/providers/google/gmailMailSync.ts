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
  renewSyncLease,
} from '../../syncCoordinator.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { fetchGmailLabels, gmailFolderPathMap, primaryFolderPathForGmailLabels } from './gmailLabels.js';
import type { GmailLabel, LocalMailFolder } from './gmailLabels.js';
import {
  fetchGmailHistoryPage,
  fetchGmailMessageIds,
  fetchGmailProfileHistoryId,
  fetchGmailThread,
  gmailHistoryChanges,
  localMessageForGmailMessage,
  providerUidForGmailMessage,
} from './gmailMail.js';
import type { GmailThread, LocalGmailMessage } from './gmailMail.js';
import { persistConversationCopyForRow } from '../../conversationRowIngest.js';
import type { ConversationAccountRow } from '../../conversationRowIngest.js';
import type { FetchLike, GoogleConfig } from '../../providerAuthService.js';

/**
 * Gmail **label discovery** (P08, first slice).
 *
 * The first step of the Gmail API vertical: a connected mailbox's labels become the
 * local `folders` rows the rest of the application already reads, and each label is
 * linked to its Gmail label id through `integration_collections` (`kind =
 * 'mail_label'`, a value migration 0101 already declares), so a message sync has
 * somewhere to put its cursor, a rename is recognised as a rename, and the folder a
 * move must add/remove is addressable by the provider's own id.
 *
 * A label listing is a full snapshot rather than a delta — Gmail has no label delta
 * — and a label tree is small enough that a snapshot is the simpler correct answer.
 * The run still takes the P03 sync lease, so two passes cannot interleave.
 *
 * A label that disappeared from Gmail is reconciled rather than left behind: its
 * collection and local folder go, and the messages that were filed under it are
 * **re-homed** to the next mailbox their stored label set names, or removed from
 * the local view when the message is now archived. Messages are never deleted
 * merely because a label was; a Gmail message is in several places at once and
 * dropping it would lose mail the user still has.
 */

export interface GmailLabelSyncResult {
  accountId: string;
  /** Folder-bearing labels in the provider's listing. */
  labels: number;
  created: number;
  updated: number;
  renamed: number;
  /** Local folders removed because their Gmail label no longer exists. */
  deleted: number;
  /** Messages re-homed or removed from the local view by that reconciliation. */
  relocatedMessages: number;
}

interface LabelContext {
  userId: string;
  connectionId: string;
  accountId: string;
}

/** The Gmail mail accounts of one connection belong to a single owner. */
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
export async function listGmailMailAccounts(client: PoolClient, input: { userId: string; connectionId: string }): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT a.id FROM email_accounts a
      WHERE a.user_id = $1 AND a.mail_transport = 'gmail_api'
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

/** Find or create the local folder a Gmail label projects onto, and link it. */
async function applyLabel(client: PoolClient, context: LabelContext, remoteId: string, local: LocalMailFolder): Promise<{
  outcome: 'created' | 'updated';
  renamed: boolean;
  movedMessages: number;
  folderId: string;
}> {
  const link = await client.query<{ id: string; local_folder_id: string | null }>(
    `SELECT id, local_folder_id FROM integration_collections
      WHERE connection_id = $1 AND kind = 'mail_label' AND remote_id = $2`,
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
    if (!folderId) throw new Error('Could not create the Gmail label folder');
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
       VALUES ($1,$2,$3,'mail_label',$4,$5,true,'read_only','source','off')
       ON CONFLICT DO NOTHING`,
      [context.userId, context.connectionId, context.accountId, remoteId, folderId],
    );
  }

  return { outcome, renamed: previousPath !== null && previousPath !== local.path, movedMessages, folderId };
}

/**
 * Re-home the messages filed under a label that no longer exists.
 *
 * The stored `provider_labels` is the authority: it is the label id set Gmail
 * reported for the message when it was ingested. A message that still carries
 * another mailbox label is moved to it; a message that now names no mailbox is
 * archived, which is the state this adapter models by **not** keeping a local
 * folder row — so its row is removed rather than re-filed under a synthetic path.
 *
 * A row with no stored label set (an IMAP-ingested row, or one written before
 * migration 0111) is left untouched: deleting it would be guessing.
 */
async function rehomeMessagesFromDeletedLabel(
  client: PoolClient,
  context: LabelContext,
  removedPath: string,
  pathByLabelId: ReadonlyMap<string, string>,
): Promise<number> {
  const rows = await client.query<{ id: string; provider_labels: string[] | null }>(
    `SELECT id, provider_labels FROM messages
      WHERE account_id = $1 AND folder = $2 AND provider_labels IS NOT NULL`,
    [context.accountId, removedPath],
  );
  let changed = 0;
  for (const row of rows.rows) {
    const labels = row.provider_labels ?? [];
    const destination = primaryFolderPathForGmailLabels(labels, pathByLabelId);
    if (destination === null) {
      await client.query('DELETE FROM messages WHERE id = $1', [row.id]);
      changed += 1;
      continue;
    }
    if (destination === removedPath) continue;
    await client.query('UPDATE messages SET folder = $1, synced_at = NOW() WHERE id = $2', [destination, row.id]);
    changed += 1;
  }
  return changed;
}

/**
 * Apply a whole label snapshot for one account inside one transaction.
 *
 * `complete` says whether the listing was the provider's whole label set. A
 * truncated listing must not be read as "every other label was deleted", so
 * reconciliation only runs on a complete snapshot.
 */
export async function applyGmailMailLabels(
  client: PoolClient,
  context: LabelContext,
  folders: ReadonlyMap<string, LocalMailFolder>,
  options: { complete?: boolean } = {},
): Promise<{ created: number; updated: number; renamed: number; deleted: number; relocatedMessages: number }> {
  const totals = { created: 0, updated: 0, renamed: 0, deleted: 0, relocatedMessages: 0 };
  for (const [remoteId, local] of folders) {
    const applied = await applyLabel(client, context, remoteId, local);
    if (applied.outcome === 'created') totals.created += 1;
    else totals.updated += 1;
    if (applied.renamed) totals.renamed += 1;
    totals.relocatedMessages += applied.movedMessages;
  }

  if (options.complete === false) return totals;

  const stale = await client.query<{ id: string; remote_id: string; path: string | null }>(
    `SELECT ic.id, ic.remote_id, f.path
       FROM integration_collections ic
       LEFT JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_label'
        AND ic.remote_id <> ALL($3::text[])`,
    [context.connectionId, context.accountId, [...folders.keys()]],
  );

  const pathByLabelId = new Map<string, string>();
  for (const [remoteId, local] of folders) pathByLabelId.set(remoteId, local.path);

  for (const row of stale.rows) {
    if (row.path) {
      totals.relocatedMessages += await rehomeMessagesFromDeletedLabel(client, context, row.path, pathByLabelId);
      await client.query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [context.accountId, row.path]);
    }
    await client.query('DELETE FROM integration_collections WHERE id = $1', [row.id]);
    totals.deleted += 1;
  }

  return totals;
}

/**
 * Discover the labels of every Gmail API account on one connection.
 *
 * A connection with no Gmail API mail account is a no-op rather than an error: the
 * provider connection also serves calendars and contacts.
 */
export async function syncGmailMailLabels(input: {
  userId: string;
  connectionId: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
  owner?: string;
}): Promise<GmailLabelSyncResult[]> {
  const accountIds = await withTransaction(client => listGmailMailAccounts(client, {
    userId: input.userId,
    connectionId: input.connectionId,
  }));

  const results: GmailLabelSyncResult[] = [];
  for (const accountId of accountIds) {
    results.push(await syncGmailMailLabelsForAccount({ ...input, accountId }));
  }
  return results;
}

/** Discover the labels of one Gmail API account under the P03 sync lease. */
export async function syncGmailMailLabelsForAccount(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
  owner?: string;
}): Promise<GmailLabelSyncResult> {
  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    feature: 'mail',
    coverage: 'labels',
  }));

  const owner = input.owner ?? `gmail-labels:${input.accountId}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GoogleApiError({
      code: 'RATE_LIMITED',
      message: 'Another Gmail label sync is already running for this account',
      status: 409,
      retryable: true,
    });
  }

  const api: GoogleApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    config: input.config,
    owner,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
  const context: LabelContext = {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
  };

  try {
    const { labels, complete } = await fetchGmailLabels(api);
    const mapped = gmailFolderPathMap(labels);
    const applied = await withTransaction(client => applyGmailMailLabels(client, context, mapped, { complete }));
    // The label snapshot completed its declared scope, so this is a finished run, not a progress checkpoint.
    const committed = await withTransaction(async client => {
      const saved = await commitSyncCheckpoint(client, {
        syncStateId,
        generation: lease.generation,
        clearPageCheckpoint: true,
        lastErrorCode: null,
      });
      if (!saved) return false;
      return finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null });
    });
    if (!committed) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The sync lease was lost before the label snapshot could be recorded',
        status: 409,
      });
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return {
      accountId: input.accountId,
      labels: mapped.size,
      created: applied.created,
      updated: applied.updated,
      renamed: applied.renamed,
      deleted: applied.deleted,
      relocatedMessages: applied.relocatedMessages,
    };
  } catch (caught) {
    // See the Graph mail sync: an authorization failure is a `ProviderAuthError`, not a `GoogleApiError`, and
    // reporting it as INTERNAL_ERROR hides the instruction the user needs.
    const code = caught instanceof GoogleApiError || caught instanceof ProviderAuthError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * The Gmail label id a local folder path projects from.
 *
 * A move addresses a label by the provider's own id, and everything above this
 * layer addresses a folder by its local path, so the link the label slice created
 * (`integration_collections.local_folder_id` ↔ `remote_id`) is read backwards
 * here. `null` means the path is not a label this connection discovered, which is a
 * refusal rather than an invitation to guess.
 */
export async function gmailLabelIdForPath(input: { connectionId: string; accountId: string; path: string }): Promise<string | null> {
  const result = await query<{ remote_id: string }>(
    `SELECT ic.remote_id
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_label' AND f.path = $3
      LIMIT 1`,
    [input.connectionId, input.accountId, input.path],
  );
  return result.rows[0]?.remote_id ?? null;
}

/** The folder-bearing labels of one account as the message sync reads them. */
export interface GmailFolderTarget {
  collectionId: string;
  remoteId: string;
  folderPath: string;
}

export async function listGmailFolderTargets(client: PoolClient, input: { connectionId: string; accountId: string }): Promise<GmailFolderTarget[]> {
  const result = await client.query<{ collection_id: string; remote_id: string; path: string }>(
    `SELECT ic.id AS collection_id, ic.remote_id, f.path
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_label' AND ic.enabled = true
      ORDER BY f.path`,
    [input.connectionId, input.accountId],
  );
  return result.rows.map(row => ({ collectionId: row.collection_id, remoteId: row.remote_id, folderPath: row.path }));
}

/** The label ids that are mailboxes for this account, as a path lookup. */
export async function gmailFolderPathByLabelId(input: { connectionId: string; accountId: string }): Promise<Map<string, string>> {
  const result = await query<{ remote_id: string; path: string }>(
    `SELECT ic.remote_id, f.path
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1 AND ic.account_id = $2 AND ic.kind = 'mail_label'`,
    [input.connectionId, input.accountId],
  );
  const map = new Map<string, string>();
  for (const row of result.rows) map.set(row.remote_id, row.path);
  return map;
}

// ── Message and thread ingest ────────────────────────────────────────────────

/**
 * Gmail **message and thread ingest** (P08, second slice).
 *
 * Gmail is read the way its own API models it: a mailbox-wide **history cursor**
 * (`users.history.list` from a stored `historyId`) names the threads that changed,
 * and each changed thread is re-read whole so the projector can derive every
 * message's current primary folder from its current label set. A first run has no
 * cursor and builds a **baseline** from `users.messages.list` per mailbox label,
 * recording the mailbox's `historyId` *before* it starts so every change that
 * happens while it runs is replayed afterwards rather than lost.
 *
 * Two rules are inherited deliberately from the IMAP/Graph paths rather than
 * invented: the `*_changed_at` local-wins window, so a flag the user just changed is
 * not reverted by a sync that read the provider before the change landed; and an
 * expired history id (Gmail answers `404`) rebuilding the mailbox from a baseline
 * **and reconciling**, because a plain re-read would miss whatever was deleted while
 * the cursor was unusable.
 *
 * A baseline is resumable: its position (label, page token and the captured history
 * id) lives in the sync state's `page_checkpoint`, so a mailbox larger than one run's
 * budget continues from where it stopped instead of restarting, and the cursor is
 * only advanced once every label has been listed.
 */

export interface GmailMailMessageSyncResult {
  accountId: string;
  /** Mailbox labels the run wrote messages for. */
  labels: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  /** True when this run rebuilt from a baseline (first run, or an expired cursor). */
  fullSync: boolean;
  /** True when the baseline stopped at its budget and a later run must continue it. */
  incomplete: boolean;
  /** The mailbox history id stored after the run. */
  cursor: string | null;
  mode: 'baseline' | 'incremental';
}

/** The local-wins window the IMAP path uses, in seconds. */
const LOCAL_WINS_SECONDS = 30;
/** Threads one run may read. A larger baseline resumes; a larger delta rebuilds. */
export const GMAIL_MAX_THREADS_PER_RUN = 1000;
const MAX_LIST_PAGES_PER_LABEL = 200;
const MAX_HISTORY_PAGES = 200;

/** The context one thread or folder is applied in. */
export interface GmailMessageContext {
  accountId: string;
  /** The account's folder-bearing labels, as label id → local path. */
  pathByLabelId: ReadonlyMap<string, string>;
  /** Overridable in tests; the API host is what the provider namespace records. */
  host?: string;
}

/** The baseline's own resume position. */
interface GmailBaselineCheckpoint {
  labelId: string | null;
  pageToken: string | null;
  startHistoryId: string | null;
}

function parseBaselineCheckpoint(raw: string | null): GmailBaselineCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    return {
      labelId: typeof candidate.labelId === 'string' ? candidate.labelId : null,
      pageToken: typeof candidate.pageToken === 'string' ? candidate.pageToken : null,
      startHistoryId: typeof candidate.startHistoryId === 'string' ? candidate.startHistoryId : null,
    };
  } catch {
    // A checkpoint written by another version, or a truncated one, is not a reason to
    // fail the sync: the run starts the baseline again from the beginning.
    return null;
  }
}

/**
 * Upsert one Gmail message.
 *
 * The `ON CONFLICT` target is the partial provider-identity index: an identical
 * message is updated in place, so re-reading the same thread changes nothing. A `uid`
 * collision — astronomically unlikely, and possible only between two *different*
 * provider ids — is resolved by asking for the next derived number instead of
 * failing the thread.
 *
 * `provider_labels` is written every time because it is what a message's additional
 * labels are kept in, and what a deleted label is resolved against.
 */
export async function applyGmailMessage(
  client: PoolClient,
  context: GmailMessageContext,
  local: LocalGmailMessage,
): Promise<{ id: string; inserted: boolean } | null> {
  if (local.folderPath === null) {
    // Archived: no label this account models is a mailbox. The IMAP path keeps such a
    // message only in Gmail's "All Mail", which Inboxora deliberately does not sync,
    // so the local row goes rather than being filed under a folder Gmail has none of.
    await client.query(
      'DELETE FROM messages WHERE account_id = $1 AND provider_message_id = $2',
      [context.accountId, local.providerMessageId],
    );
    return null;
  }

  let applied: { id: string; inserted: boolean } | null = null;
  for (let attempt = 0; attempt < 3 && !applied; attempt++) {
    const uid = attempt === 0 ? local.uid : providerUidForGmailMessage(local.providerMessageId, attempt);
    try {
      // The legacy (account_id, uid, folder) index can reject the derived number, and a failed statement
      // aborts the transaction; the savepoint is what lets the next attempt run at all (DB-01).
      applied = await withSavepoint(client, `gmail_uid_${attempt}`, async () => {
        const result = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO messages (
             account_id, uid, folder, provider_message_id, message_id, thread_id, provider_thread_id,
             provider_namespace, provider_labels, subject, from_name, from_email,
             to_addresses, cc_addresses, reply_to, date, snippet, is_read, is_starred, has_attachments, synced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,NOW())
           ON CONFLICT (account_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO UPDATE SET
             folder = EXCLUDED.folder,
             uid = EXCLUDED.uid,
             message_id = EXCLUDED.message_id,
             thread_id = EXCLUDED.thread_id,
             provider_thread_id = EXCLUDED.provider_thread_id,
             provider_namespace = EXCLUDED.provider_namespace,
             provider_labels = EXCLUDED.provider_labels,
             subject = EXCLUDED.subject,
             from_name = EXCLUDED.from_name,
             from_email = EXCLUDED.from_email,
             to_addresses = EXCLUDED.to_addresses,
             cc_addresses = EXCLUDED.cc_addresses,
             reply_to = EXCLUDED.reply_to,
             date = EXCLUDED.date,
             snippet = EXCLUDED.snippet,
             is_read = CASE
               WHEN messages.read_changed_at IS NULL OR messages.read_changed_at < NOW() - make_interval(secs => $21)
                 THEN EXCLUDED.is_read ELSE messages.is_read END,
             is_starred = CASE
               WHEN messages.star_changed_at IS NULL OR messages.star_changed_at < NOW() - make_interval(secs => $21)
                 THEN EXCLUDED.is_starred ELSE messages.is_starred END,
             has_attachments = EXCLUDED.has_attachments,
             synced_at = NOW()
           RETURNING id, (xmax = 0) AS inserted`,
          [
            context.accountId, uid, local.folderPath, local.providerMessageId, local.messageId, local.threadId,
            local.providerThreadId, local.providerNamespace, local.labels,
            local.subject, local.fromName, local.fromEmail,
            JSON.stringify(local.toAddresses), JSON.stringify(local.ccAddresses), JSON.stringify(local.replyTo),
            local.date, local.snippet, local.isRead, local.isStarred, local.hasAttachments, LOCAL_WINS_SECONDS,
          ],
        );
        return result.rows[0] ?? null;
      });
    } catch (caught) {
      // 23505 here is the legacy (account_id, uid, folder) index: another message
      // already owns this derived number, so ask for the next one.
      if (toAppError(caught).code === '23505') continue;
      throw caught;
    }
  }
  return applied;
}

/**
 * Apply one whole thread.
 *
 * A thread is reconciled as a unit on purpose: the history feed names the thread,
 * and re-reading it gives every message's current label set — so a message that left
 * a mailbox, arrived in one, was renamed or was trashed is all handled by the same
 * projection, with no separate delta shape to get wrong.
 */
export async function applyGmailThread(
  client: PoolClient,
  context: GmailMessageContext,
  thread: GmailThread,
  seenProviderIds?: Set<string>,
): Promise<{ created: number; updated: number; deleted: number; skipped: number; rowIds: string[] }> {
  const totals = { created: 0, updated: 0, deleted: 0, skipped: 0, rowIds: [] as string[] };
  for (const message of thread.messages ?? []) {
    const local = localMessageForGmailMessage(message, {
      accountId: context.accountId,
      pathByLabelId: context.pathByLabelId,
      ...(context.host ? { host: context.host } : {}),
    });
    if (!local) { totals.skipped += 1; continue; }
    if (local.folderPath === null) {
      const removed = await client.query(
        'DELETE FROM messages WHERE account_id = $1 AND provider_message_id = $2',
        [context.accountId, local.providerMessageId],
      );
      if ((removed.rowCount ?? 0) > 0) totals.deleted += 1;
      else totals.skipped += 1;
      continue;
    }
    seenProviderIds?.add(local.providerMessageId);
    const applied = await applyGmailMessage(client, context, local);
    if (!applied) { totals.skipped += 1; continue; }
    // Collected so the caller can run the conversation projection **after** this
    // transaction commits: the engine opens its own, and nesting the two is the
    // mistake this return value exists to prevent.
    totals.rowIds.push(applied.id);
    if (applied.inserted) totals.created += 1;
    else totals.updated += 1;
  }
  return totals;
}

/** Remove the local messages of one provider id set (the history's deletions). */
export async function deleteGmailMessagesByProviderId(
  client: PoolClient,
  accountId: string,
  providerMessageIds: readonly string[],
): Promise<number> {
  if (providerMessageIds.length === 0) return 0;
  const removed = await client.query(
    'DELETE FROM messages WHERE account_id = $1 AND provider_message_id = ANY($2::text[])',
    [accountId, [...providerMessageIds]],
  );
  return removed.rowCount ?? 0;
}

/** Remove the local provider messages of a folder that a rebuilt baseline did not list. */
export async function reconcileGmailFolder(
  client: PoolClient,
  context: GmailMessageContext,
  folderPath: string,
  seenProviderIds: ReadonlySet<string>,
): Promise<number> {
  const removed = await client.query(
    `DELETE FROM messages
      WHERE account_id = $1 AND folder = $2 AND provider_message_id IS NOT NULL
        AND provider_message_id <> ALL($3::text[])`,
    [context.accountId, folderPath, [...seenProviderIds]],
  );
  return removed.rowCount ?? 0;
}

/**
 * Project the messages a thread wrote into the conversation engine.
 *
 * Called **after** the thread's transaction commits — the engine opens its own — and
 * one row at a time so a single failure is recorded against that row by the shared
 * function rather than aborting the sync. The body of a Gmail message is not needed
 * here: delivery and provider metadata come from the persisted row, which is what the
 * ingest paths share.
 */
async function persistConversations(rowIds: readonly string[], account: ConversationAccountRow): Promise<void> {
  for (const rowId of rowIds) {
    await persistConversationCopyForRow(rowId, account, null).catch(error =>
      console.warn(`Gmail conversation projection failed for ${rowId}:`, error instanceof Error ? error.message : error));
  }
}

/** The totals one pass (baseline or incremental) produced. */
interface MessageTotals {
  created: number; updated: number; deleted: number; skipped: number;
}

function addTotals(target: MessageTotals, source: MessageTotals): void {
  target.created += source.created;
  target.updated += source.updated;
  target.deleted += source.deleted;
  target.skipped += source.skipped;
}

/**
 * Sync the messages of one Gmail API account.
 *
 * Labels must have been discovered first: a label with no collection and no local
 * path has no `messages.folder` value to write, and a message's primary folder is
 * only resolvable against those paths.
 */
export async function syncGmailMailMessagesForAccount(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
  owner?: string;
  /**
   * How many threads one run may read. Defaults to
   * {@link GMAIL_MAX_THREADS_PER_RUN}; injectable so the resume path is provable
   * without a mailbox of a thousand threads.
   */
  maxThreadsPerRun?: number;
}): Promise<GmailMailMessageSyncResult> {
  const accountResult = await query<ConversationAccountRow>(
    'SELECT id, user_id, imap_host, mail_transport FROM email_accounts WHERE id = $1',
    [input.accountId],
  );
  const account = accountResult.rows[0];
  if (!account) {
    return {
      accountId: input.accountId, labels: 0, created: 0, updated: 0, deleted: 0, skipped: 0,
      fullSync: false, incomplete: false, cursor: null, mode: 'baseline',
    };
  }

  const targets = await withTransaction(client => listGmailFolderTargets(client, input));
  const pathByLabelId = await gmailFolderPathByLabelId({ connectionId: input.connectionId, accountId: input.accountId });
  const context: GmailMessageContext = { accountId: input.accountId, pathByLabelId };

  const syncStateId = await withTransaction(client => ensureSyncState(client, {
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    feature: 'mail',
    coverage: 'history',
  }));

  const owner = input.owner ?? `gmail-mail:${input.accountId}`;
  const lease = await withTransaction(client => acquireSyncLease(client, { syncStateId, owner }));
  if (!lease) {
    throw new GoogleApiError({
      code: 'RATE_LIMITED',
      message: 'Another Gmail message sync is already running for this account',
      status: 409,
      retryable: true,
    });
  }

  const api: GoogleApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    config: input.config,
    owner,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };

  const renew = async (): Promise<void> => {
    const held = await withTransaction(client => renewSyncLease(client, { syncStateId, generation: lease.generation }));
    if (!held) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The Gmail message sync lost its lease while it was running',
        status: 409,
      });
    }
  };
  const commit = async (checkpoint: { cursor?: string | null; pageCheckpoint?: string | null; clearPageCheckpoint?: boolean }): Promise<void> => {
    const committed = await withTransaction(client => commitSyncCheckpoint(client, {
      syncStateId,
      generation: lease.generation,
      ...(checkpoint.cursor !== undefined ? { cursor: checkpoint.cursor } : {}),
      ...(checkpoint.pageCheckpoint !== undefined ? { pageCheckpoint: checkpoint.pageCheckpoint } : {}),
      ...(checkpoint.clearPageCheckpoint ? { clearPageCheckpoint: true } : {}),
      lastErrorCode: null,
    }));
    if (!committed) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The Gmail message sync lost its lease before it could store its cursor',
        status: 409,
      });
    }
  };
  /** Mark the run finished. Only a run that completed its declared scope may claim a successful sync (SYNC-02). */
  const finish = async (): Promise<void> => {
    const done = await withTransaction(client => finishSyncRun(client, { syncStateId, generation: lease.generation, lastErrorCode: null }));
    if (!done) {
      throw new GoogleApiError({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        message: 'The Gmail message sync lost its lease before it could record its completion',
        status: 409,
      });
    }
  };

  const maxThreadsPerRun = input.maxThreadsPerRun ?? GMAIL_MAX_THREADS_PER_RUN;
  const state = await withTransaction(client => readSyncState(client, syncStateId));
  let cursor = state?.cursor ?? null;
  let pageCheckpoint = state?.pageCheckpoint ?? null;
  const totals: MessageTotals = { created: 0, updated: 0, deleted: 0, skipped: 0 };
  let mode: 'baseline' | 'incremental' = cursor === null ? 'baseline' : 'incremental';
  let incomplete = false;
  let fullSync = cursor === null;

  try {
    if (mode === 'incremental' && cursor !== null) {
      const applied = await runIncremental(api, context, account, cursor, totals, renew, maxThreadsPerRun);
      if (applied === 'expired') {
        // Gmail answered `404` for the stored history id: it has aged out. A baseline
        // is the only honest recovery, and it reconciles.
        cursor = null;
        pageCheckpoint = null;
        mode = 'baseline';
        fullSync = true;
      } else {
        cursor = applied.cursor;
      }
    }

    if (mode === 'baseline') {
      const baseline = await runBaseline(api, context, account, targets, totals, pageCheckpoint, commit, renew, maxThreadsPerRun);
      incomplete = baseline.incomplete;
      if (!incomplete) {
        cursor = baseline.startHistoryId ?? cursor;
        pageCheckpoint = null;
      }
    }

    if (!incomplete) {
      await commit({ cursor, clearPageCheckpoint: true });
      await finish();
    }
    await withTransaction(client => releaseSyncLease(client, { syncStateId, generation: lease.generation })).catch(() => {});
    return { accountId: input.accountId, labels: targets.length, ...totals, fullSync, incomplete, cursor, mode };
  } catch (caught) {
    // See the Graph mail sync: an authorization failure is a `ProviderAuthError`, not a `GoogleApiError`, and
    // reporting it as INTERNAL_ERROR hides the instruction the user needs.
    const code = caught instanceof GoogleApiError || caught instanceof ProviderAuthError ? caught.code : 'INTERNAL_ERROR';
    await withTransaction(client => failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code })).catch(() => {});
    throw caught;
  }
}

/**
 * Read the history feed and apply every changed thread.
 *
 * `'expired'` means the stored cursor is unusable and the caller must rebuild. A
 * feed that names more threads than one run may read is treated the same way: it is
 * cheaper and safer to rebuild a bounded, resumable baseline than to apply an
 * unbounded delta.
 */
async function runIncremental(
  api: GoogleApiOptions,
  context: GmailMessageContext,
  account: ConversationAccountRow,
  cursor: string,
  totals: MessageTotals,
  renew: () => Promise<void>,
  maxThreadsPerRun: number,
): Promise<{ cursor: string } | 'expired'> {
  const threadIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  let pageToken: string | null = null;
  let nextHistoryId: string | null = null;
  let historyComplete = false;

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    let fetched;
    try {
      fetched = await fetchGmailHistoryPage(api, { startHistoryId: cursor, pageToken });
    } catch (caught) {
      // Gmail answers `404` for a history id that has aged out; the local classifier
      // calls that `RESOURCE_NOT_FOUND`, and `410` is the shape the domain already
      // uses for "cursor invalid". Both mean the same thing to this caller.
      if (caught instanceof GoogleApiError && (caught.code === 'RESOURCE_NOT_FOUND' || caught.code === 'INVALID_SYNC_CURSOR')) {
        return 'expired';
      }
      throw caught;
    }
    const changes = gmailHistoryChanges(fetched.history ?? []);
    for (const threadId of changes.threadIds) threadIds.add(threadId);
    for (const messageId of changes.deletedMessageIds) deletedMessageIds.add(messageId);
    if (fetched.historyId) nextHistoryId = fetched.historyId;
    pageToken = fetched.nextPageToken ?? null;
    if (!pageToken) { historyComplete = true; break; }
    await renew();
  }

  // The feed had more pages than one run may read. The cursor must not advance to the last page's history id:
  // that would skip every change on the remaining pages for ever, silently (SYNC-06). The end of the loop is
  // decided by `pageToken` alone, not by the number of distinct threads — many pages can describe few threads.
  // Rebuilding from a baseline is the safe answer: it reconciles and captures a fresh history id.
  if (!historyComplete) return 'expired';

  // Not a bounded delta: rebuild instead of applying an unbounded page of changes.
  if (threadIds.size > maxThreadsPerRun) return 'expired';

  for (const threadId of threadIds) {
    const thread = await fetchGmailThread(api, threadId);
    if (!thread) continue;
    const applied = await withTransaction(client => applyGmailThread(client, context, thread));
    await persistConversations(applied.rowIds, account);
    addTotals(totals, applied);
  }

  if (deletedMessageIds.size > 0) {
    totals.deleted += await withTransaction(client => deleteGmailMessagesByProviderId(client, context.accountId, [...deletedMessageIds]));
  }

  await renew();
  return { cursor: nextHistoryId ?? cursor };
}

/**
 * Build (or continue) the baseline, one label at a time.
 *
 * The captured `historyId` is stored in the checkpoint **before** the listing starts,
 * so a change that lands while the baseline is still running is replayed from the
 * history feed afterwards instead of being skipped — the baseline is allowed to be
 * incomplete, and that is what makes it safe.
 */
async function runBaseline(
  api: GoogleApiOptions,
  context: GmailMessageContext,
  account: ConversationAccountRow,
  targets: readonly GmailFolderTarget[],
  totals: MessageTotals,
  pageCheckpoint: string | null,
  commit: (checkpoint: { cursor?: string | null; pageCheckpoint?: string | null; clearPageCheckpoint?: boolean }) => Promise<void>,
  renew: () => Promise<void>,
  maxThreadsPerRun: number,
): Promise<{ incomplete: boolean; startHistoryId: string | null }> {
  const checkpoint = parseBaselineCheckpoint(pageCheckpoint) ?? { labelId: null, pageToken: null, startHistoryId: null };
  const startHistoryId = checkpoint.startHistoryId ?? await fetchGmailProfileHistoryId(api);

  let startIndex = 0;
  if (checkpoint.labelId) {
    const found = targets.findIndex(target => target.remoteId === checkpoint.labelId);
    // A label that disappeared while the baseline was paused is not an error: the run
    // restarts the listing from the beginning, because there is no page to resume.
    startIndex = found >= 0 ? found : 0;
  }

  let budget = maxThreadsPerRun;
  for (let index = startIndex; index < targets.length; index++) {
    const target = targets[index];
    if (!target) continue;
    const resumed = index === startIndex && checkpoint.labelId === target.remoteId && checkpoint.pageToken !== null;
    let pageToken: string | null = resumed ? checkpoint.pageToken : null;
    const seen = new Set<string>();
    let completed = false;

    for (let page = 0; page < MAX_LIST_PAGES_PER_LABEL; page++) {
      const listing = await fetchGmailMessageIds(api, {
        labelId: target.remoteId,
        pageToken,
        includeSpamTrash: true,
      });
      const threadIds = [...new Set(
        listing.messages
          .map(message => message.threadId?.trim())
          .filter((threadId): threadId is string => Boolean(threadId)),
      )];

      let pageComplete = true;
      for (const threadId of threadIds) {
        if (budget <= 0) { pageComplete = false; break; }
        const thread = await fetchGmailThread(api, threadId);
        budget -= 1;
        if (!thread) continue;
        const applied = await withTransaction(client => applyGmailThread(client, context, thread, seen));
        await persistConversations(applied.rowIds, account);
        addTotals(totals, applied);
      }

      if (!pageComplete) {
        // The budget ran out inside this page. Re-read the **whole label** from its first page next time
        // (`pageToken: null`) rather than storing `listing.nextPageToken`: that token only ever moves forward, so
        // it skipped every thread of this page that had not been read yet, and those threads were never stored
        // (SYNC-05). Re-reading is idempotent — a thread upserts — and it means the label reconciles against a
        // complete snapshot when it eventually finishes.
        await commit({
          cursor: null,
          pageCheckpoint: JSON.stringify({ labelId: target.remoteId, pageToken: null, startHistoryId } satisfies GmailBaselineCheckpoint),
        });
        return { incomplete: true, startHistoryId };
      }

      // The page itself was fully applied. The end-of-list test must come before any budget test: a budget that
      // ended exactly on the last thread of the last page used to satisfy `budget <= 0` and look like an
      // interruption, which stored a null page token and restarted the label on every run.
      pageToken = listing.nextPageToken;
      if (!pageToken) { completed = true; break; }
      await renew();
    }

    if (completed) {
      if (!resumed) {
        // Only a label listed from its first page in this run can be reconciled: a
        // resumed listing has no record of the pages an earlier run already saw.
        totals.deleted += await withTransaction(client => reconcileGmailFolder(client, context, target.folderPath, seen));
      }
    } else {
      await commit({
        cursor: null,
        pageCheckpoint: JSON.stringify({ labelId: target.remoteId, pageToken, startHistoryId } satisfies GmailBaselineCheckpoint),
      });
      return { incomplete: true, startHistoryId };
    }

    const next = targets[index + 1];
    await commit({
      cursor: null,
      pageCheckpoint: JSON.stringify({ labelId: next?.remoteId ?? null, pageToken: null, startHistoryId } satisfies GmailBaselineCheckpoint),
    });
    await renew();
  }

  return { incomplete: false, startHistoryId };
}

export type { GmailLabel };
