import { query, withTransaction } from '../../db.js';
import { graphGet, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { GRAPH_MESSAGE_SELECT, MESSAGE_PAGE_SIZE, localMessageForGraphMessage } from './graphMail.js';
import type { GraphMessage, GraphMessagePage } from './graphMail.js';
import {
  applyGraphMailMessagesPage,
  listGraphFolderTargets,
  persistConversations,
  syncGraphMailFoldersForAccount,
} from './graphMailSync.js';
import type { ConversationAccountRow } from '../../conversationRowIngest.js';
import type { FetchLike } from '../../providerAuthService.js';

/**
 * Microsoft Graph **provider-side mail search** (P07b, the search slice).
 *
 * The local `/api/search` reads Inboxora's own `messages` rows, which for a native
 * account is only what the delta cursor has pulled: old mail, folders the user never
 * opened and anything outside the sync's recent window are absent, so a search of such
 * a mailbox answers "no results" for mail that exists. This module asks Graph's own
 * index and **lands the hits in the local model**, so threading, opening, flagging and
 * attachments keep working on local ids and the response shape does not change.
 *
 * Three rules are inherited deliberately:
 *
 *  - the `$select` and page size are the message sync's own (`GRAPH_MESSAGE_SELECT`,
 *    `MESSAGE_PAGE_SIZE`), so a hit is the same shape the sync projects and no second
 *    projection exists to drift;
 *  - a hit is stored through `applyGraphMailMessagesPage` — the exact function the sync
 *    uses — so identity is `provider_message_id`, the local-wins flag window applies and
 *    a repeated search updates in place instead of duplicating;
 *  - a hit whose `parentFolderId` does not resolve to a local folder path is **skipped
 *    and counted**, never written into a guessed folder.
 *
 * Search never touches a delta cursor: it is a read of the mailbox into the local model,
 * not a sync, so a later delta run still resumes from the cursor it stored.
 */

/**
 * The same ceiling the local route applies to a query before it reaches here. Bound
 * again at this boundary so the escaping rule has one place that cannot be bypassed.
 */
export const GRAPH_SEARCH_MAX_QUERY_LENGTH = 500;

/** One page of hits, the size the message sync asks for. */
export const GRAPH_SEARCH_PAGE_SIZE = MESSAGE_PAGE_SIZE;

/** Trim and bound a user query. */
export function boundGraphSearchQuery(raw: string): string {
  return raw.trim().slice(0, GRAPH_SEARCH_MAX_QUERY_LENGTH);
}

/**
 * Escape a user string for Graph's `$search` value.
 *
 * `$search` is a KQL expression wrapped in double quotes, so a backslash is an escape
 * character inside the literal and an unescaped `"` would close it early — which is
 * how an ordinary subject line turns into a malformed query. The backslash is escaped
 * first, because escaping the quote first would double the backslashes this step adds.
 */
export function escapeGraphSearchQuery(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The one-page search URL: the message sync's projection fields, the query as a quoted
 * KQL literal, and an explicit `$top` rather than Graph's default page size.
 */
export function graphMailSearchUrl(query: string, options: { top?: number } = {}): string {
  return graphUrl('/me/messages', {
    $search: `"${escapeGraphSearchQuery(boundGraphSearchQuery(query))}"`,
    $select: GRAPH_MESSAGE_SELECT,
    $top: options.top ?? GRAPH_SEARCH_PAGE_SIZE,
  });
}

export interface GraphMailSearchPage {
  messages: GraphMessage[];
  nextLink: string | null;
}

/**
 * Read one page of the mailbox's search results.
 *
 * `nextLink` is Graph's own continuation, passed back verbatim on the next call — the
 * query is not re-sent, because Graph has already resolved it. An empty query is a
 * no-op rather than a request that would ask Graph to match everything, so it answers
 * with no hits and no continuation.
 */
export async function searchGraphMessagesPage(
  api: GraphApiOptions,
  input: { query: string; nextLink?: string | null; top?: number },
): Promise<GraphMailSearchPage> {
  const query = boundGraphSearchQuery(input.query);
  if (!query) return { messages: [], nextLink: null };

  const url = input.nextLink ?? graphMailSearchUrl(query, { top: input.top });
  const page = await graphGet<GraphMessagePage>(api, url);
  return {
    messages: page.value ?? [],
    nextLink: page['@odata.nextLink'] ?? null,
  };
}

export interface GraphMailSearchIngestResult {
  accountId: string;
  /** Messages the provider's first search page returned. */
  hits: number;
  created: number;
  updated: number;
  /** Hits that could not be projected: no id, a removal, or an unresolvable folder. */
  skipped: number;
  /** Distinct provider folder ids the skipped hits pointed at. */
  unresolvedFolders: number;
}

/** Discover this account's folder tree through the existing folder sync. */
async function discoverFolders(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
}): Promise<void> {
  await syncGraphMailFoldersForAccount({
    userId: input.userId,
    connectionId: input.connectionId,
    accountId: input.accountId,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

/**
 * Search one native account at the provider and project the hits into the local model.
 *
 * The folder collections must exist first: a hit names its folder by Graph's immutable
 * id while the local model addresses a folder by path, so an account with no discovered
 * folders is discovered here before the search. A hit in a folder the discovery never
 * linked — a collection the user disabled, or a folder created after the snapshot — has
 * no local path to be placed under and is skipped rather than invented.
 */
export async function ingestGraphMailSearch(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  query: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
}): Promise<GraphMailSearchIngestResult> {
  const empty: GraphMailSearchIngestResult = {
    accountId: input.accountId, hits: 0, created: 0, updated: 0, skipped: 0, unresolvedFolders: 0,
  };
  const searchQuery = boundGraphSearchQuery(input.query);
  if (!searchQuery) return empty;

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    owner: `graph-mail-search:${input.accountId}`,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };

  let targets = await withTransaction(client => listGraphFolderTargets(client, input));
  if (targets.length === 0) {
    await discoverFolders(input);
    targets = await withTransaction(client => listGraphFolderTargets(client, input));
  }
  const folderPathByRemoteId = new Map(targets.map(target => [target.remoteId, target.folderPath]));

  const page = await searchGraphMessagesPage(api, { query: searchQuery });

  const byFolder = new Map<string, GraphMessage[]>();
  const unresolved = new Set<string>();
  let skipped = 0;
  for (const message of page.messages) {
    // The sync's own projection decides what is projectable; asking it here keeps the
    // "what is a message" rule in one place instead of a second id/removal check.
    if (!localMessageForGraphMessage(message)) { skipped += 1; continue; }
    const folderPath = message.parentFolderId ? folderPathByRemoteId.get(message.parentFolderId) : undefined;
    if (!folderPath) {
      skipped += 1;
      if (message.parentFolderId) unresolved.add(message.parentFolderId);
      continue;
    }
    const bucket = byFolder.get(folderPath);
    if (bucket) bucket.push(message);
    else byFolder.set(folderPath, [message]);
  }

  const accountResult = await query<ConversationAccountRow>(
    'SELECT id, user_id, imap_host, mail_transport FROM email_accounts WHERE id = $1',
    [input.accountId],
  );
  const account = accountResult.rows[0];
  if (!account) return { ...empty, hits: page.messages.length, skipped };

  // One transaction for the whole page, then the conversation projection after it
  // commits — the engine opens its own transaction, so nesting the two is the mistake
  // the sync's separate step exists to prevent.
  const applied = await withTransaction(async client => {
    const totals = { created: 0, updated: 0, skipped: 0, rowIds: [] as string[] };
    for (const [folderPath, messages] of byFolder) {
      const result = await applyGraphMailMessagesPage(
        client,
        { userId: input.userId, accountId: input.accountId, folderPath },
        messages,
      );
      totals.created += result.created;
      totals.updated += result.updated;
      totals.skipped += result.skipped;
      totals.rowIds.push(...result.rowIds);
    }
    return totals;
  });

  await persistConversations(applied.rowIds, account);

  if (unresolved.size > 0) {
    console.warn(
      `Graph mail search for account ${input.accountId} skipped ${skipped} hit(s) whose folder did not resolve (${unresolved.size} provider folder id(s))`,
    );
  }

  return {
    accountId: input.accountId,
    hits: page.messages.length,
    created: applied.created,
    updated: applied.updated,
    skipped: skipped + applied.skipped,
    unresolvedFolders: unresolved.size,
  };
}
