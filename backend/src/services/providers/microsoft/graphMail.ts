import { createHash } from 'crypto';
import { GraphApiError, graphGet, graphGetWithHeaders, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';

/**
 * Microsoft Graph **mail** folders (P07b, read path).
 *
 * This is not "Graph pretending to be IMAP". Graph addresses a folder by an
 * immutable id, exposes its well-known role separately from its display name, and
 * nests folders through `childFolders` rather than through a delimiter — so the
 * adapter reads those semantics and maps them onto Inboxora's common folder model
 * (`folders.path` is the stable key every message row stores, `name` is what the
 * interface shows, `special_use` is what the trash/drafts/archive/spam resolvers
 * read).
 *
 * Two consequences worth stating, because both are deliberate:
 *
 *  - a well-known folder maps onto its **canonical local path** (`INBOX`, `Sent`,
 *    `Trash`, …), so the rest of the application keeps working for a Graph account
 *    exactly as it does for IMAP — including the code that compares `folder` to
 *    `INBOX`;
 *  - every other folder's path is derived from its display name, and its identity
 *    is the Graph id held in `integration_collections.remote_id`. A rename is
 *    therefore detected as a rename rather than as a new folder plus a deletion.
 */

/** The fields the folder adapter reads. Graph returns more; nothing else is used. */
export interface GraphMailFolder {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
  childFolderCount?: number | null;
  totalItemCount?: number | null;
  unreadItemCount?: number | null;
}

interface GraphFolderPage {
  value?: GraphMailFolder[];
  '@odata.nextLink'?: string;
}

/** A folder as the local `folders` table models it. */
export interface LocalMailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  totalCount: number;
  unreadCount: number;
}

/**
 * `$select` for a folder listing. It deliberately omits `wellKnownName`: that property exists only on the beta
 * `mailFolder` resource, and requesting it from the v1.0 endpoint this adapter is pinned to is a contract
 * violation that can fail the whole listing (GRAPH-01). The role is resolved from the folder's stable id
 * instead — see `fetchWellKnownFolderIds`.
 */
const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';
const PAGE_SIZE = 100;
/** Graph nests folders; the bound keeps a malformed tree from being walked forever. */
const MAX_FOLDER_DEPTH = 10;
export const MAX_MAIL_FOLDERS = 2000;

/**
 * Outlook's well-known folders, mapped to Inboxora's canonical local paths and to
 * the IMAP-style `special_use` values the rest of the application already reads.
 * A well-known folder keeps its canonical path whatever its display name becomes,
 * which is what makes a renamed Inbox keep working.
 */
const WELL_KNOWN_FOLDERS: Readonly<Record<string, { path: string; specialUse: string }>> = Object.freeze({
  inbox: { path: 'INBOX', specialUse: '\\Inbox' },
  sentitems: { path: 'Sent', specialUse: '\\Sent' },
  drafts: { path: 'Drafts', specialUse: '\\Drafts' },
  deleteditems: { path: 'Trash', specialUse: '\\Trash' },
  junkemail: { path: 'Spam', specialUse: '\\Junk' },
  archive: { path: 'Archive', specialUse: '\\Archive' },
  outbox: { path: 'Outbox', specialUse: '\\Outbox' },
  conversationhistory: { path: 'Conversation History', specialUse: '\\All' },
});

/**
 * The well-known names this adapter resolves. Unlike the `wellKnownName` property, these names are valid in a
 * v1.0 request path (`GET /me/mailFolders/drafts`), and they work whatever language the mailbox uses, so each
 * role is resolved to the folder's real id and matched by id rather than by a localized display name.
 */
export const WELL_KNOWN_FOLDER_ALIASES: readonly string[] = Object.freeze(Object.keys(WELL_KNOWN_FOLDERS));

/**
 * Resolve every well-known folder alias this mailbox has to its real Graph id.
 *
 * A mailbox need not have all of them (`archive` and `conversationhistory` are created lazily), so a 404 for an
 * alias is expected and skipped. Any other failure is rethrown: an incomplete role map must not be mistaken for
 * "this mailbox has no Inbox".
 */
export async function fetchWellKnownFolderIds(api: GraphApiOptions): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  for (const alias of WELL_KNOWN_FOLDER_ALIASES) {
    try {
      const folder = await graphGet<{ id?: string }>(api, graphUrl(`/me/mailFolders/${alias}`, { $select: 'id' }));
      if (folder.id) byId.set(folder.id, alias);
    } catch (caught) {
      if (caught instanceof GraphApiError && caught.code === 'RESOURCE_NOT_FOUND') continue;
      throw caught;
    }
  }
  return byId;
}

/** The local folder a Graph folder projects onto. Pure, so it can be asserted directly. */
export function localFolderForGraphFolder(
  folder: GraphMailFolder,
  parentPath: string | null,
  wellKnownName: string | null = null,
): LocalMailFolder {
  const name = (folder.displayName ?? '').trim() || folder.id;
  const wellKnown = wellKnownName ? WELL_KNOWN_FOLDERS[wellKnownName.toLowerCase()] : undefined;
  const path = wellKnown ? wellKnown.path : parentPath ? `${parentPath}/${name}` : name;
  return {
    path,
    name,
    delimiter: '/',
    specialUse: wellKnown?.specialUse ?? null,
    totalCount: Math.max(0, folder.totalItemCount ?? 0),
    unreadCount: Math.max(0, folder.unreadItemCount ?? 0),
  };
}

/**
 * Map every folder in a listing by its Graph id. A folder whose parent is not in
 * the listing is treated as a root, and a cycle is broken rather than followed.
 *
 * `wellKnownById` maps a folder id to the well-known alias resolved for it, so a renamed Inbox still lands on
 * the canonical `INBOX` path.
 */
export function graphFolderPathMap(
  folders: readonly GraphMailFolder[],
  wellKnownById: ReadonlyMap<string, string> = new Map(),
): Map<string, LocalMailFolder> {
  const byId = new Map<string, GraphMailFolder>();
  for (const folder of folders) if (folder.id) byId.set(folder.id, folder);

  const mapped = new Map<string, LocalMailFolder>();
  const resolving = new Set<string>();

  const resolve = (folder: GraphMailFolder): LocalMailFolder => {
    const existing = mapped.get(folder.id);
    if (existing) return existing;
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    let parentPath: string | null = null;
    if (parent && parent.id !== folder.id && !resolving.has(parent.id)) {
      resolving.add(folder.id);
      parentPath = resolve(parent).path;
      resolving.delete(folder.id);
    }
    const local = localFolderForGraphFolder(folder, parentPath, wellKnownById.get(folder.id) ?? null);
    mapped.set(folder.id, local);
    return local;
  };

  for (const folder of folders) if (folder.id) resolve(folder);
  return mapped;
}

/**
 * Read the whole mail-folder tree of the signed-in mailbox, parents before
 * children. `$top` pages and `@odata.nextLink` are followed explicitly rather than
 * relying on Graph's default page size.
 */
export interface GraphMailFolderSnapshot {
  folders: GraphMailFolder[];
  /**
   * False when a guard cut the walk short — the folder budget or the depth limit — so the list is a prefix and
   * must never be treated as an authoritative "these are all the folders" (GRAPH-06, SYNC-04).
   */
  complete: boolean;
}

/**
 * Read the whole mail-folder tree of the signed-in mailbox, parents before
 * children. `$top` pages and `@odata.nextLink` are followed explicitly rather than
 * relying on Graph's default page size.
 */
export async function fetchMailFolderSnapshot(
  api: GraphApiOptions,
  options: { maxFolders?: number } = {},
): Promise<GraphMailFolderSnapshot> {
  const maxFolders = options.maxFolders ?? MAX_MAIL_FOLDERS;
  const folders: GraphMailFolder[] = [];
  const queue: Array<{ id: string | null; depth: number }> = [{ id: null, depth: 0 }];
  let complete = true;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.depth > MAX_FOLDER_DEPTH) { complete = false; continue; }
    let nextLink: string | null = null;
    do {
      const page: GraphFolderPage = nextLink
        ? await graphGet<GraphFolderPage>(api, nextLink)
        : await graphGet<GraphFolderPage>(api, graphUrl(
          current.id ? `/me/mailFolders/${encodeURIComponent(current.id)}/childFolders` : '/me/mailFolders',
          { $top: PAGE_SIZE, $select: FOLDER_SELECT },
        ));
      for (const folder of page.value ?? []) {
        if (!folder.id) continue;
        folders.push(folder);
        if (folders.length >= maxFolders) return { folders, complete: false };
        if ((folder.childFolderCount ?? 0) > 0) queue.push({ id: folder.id, depth: current.depth + 1 });
      }
      nextLink = page['@odata.nextLink'] ?? null;
    } while (nextLink);
  }
  return { folders, complete };
}

/** The folder list alone, for callers that only need the tree. */
export async function fetchMailFolders(
  api: GraphApiOptions,
  options: { maxFolders?: number } = {},
): Promise<GraphMailFolder[]> {
  return (await fetchMailFolderSnapshot(api, options)).folders;
}

/**
 * A message as Graph returns it for the delta endpoint. Only the fields the
 * adapter reads are declared; the `$select` below is what asks for them.
 *
 * `internetMessageId` is the RFC `Message-ID` header and is carried through as
 * metadata only — it is neither unique nor stable, so identity is `id`.
 * `conversationId` is Graph's own thread identity and is what the conversation
 * layer keys on.
 */
export interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  hasAttachments?: boolean | null;
  flag?: { flagStatus?: string | null } | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  replyTo?: GraphRecipient[] | null;
  changeKey?: string | null;
  parentFolderId?: string | null;
  internetMessageHeaders?: Array<{ name?: string | null; value?: string | null }> | null;
  /** Set on the delta entry that reports a deletion, instead of the message. */
  '@removed'?: { reason?: string } | null;
}

/** A message projected onto the local `messages` row. */
export interface LocalGraphMessage {
  /** Compatibility number; the identity is the provider id, not this. */
  uid: string;
  providerMessageId: string;
  messageId: string | null;
  threadId: string | null;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  toAddresses: Array<{ name: string | null; address: string }>;
  ccAddresses: Array<{ name: string | null; address: string }>;
  replyTo: Array<{ name: string | null; address: string }>;
  parsedHeaders: Record<string, string>;
  /** RFC 2369 action references, normalized from Graph internet headers. */
  listUnsubscribe: string | null;
  /** RFC 8058 one-click declaration, normalized from Graph internet headers. */
  listUnsubscribePost: string | null;
  /** True only when Graph actually returned the internetMessageHeaders collection. */
  parsedHeadersComplete: boolean;
  date: Date | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  isDraft: boolean;
}

export const GRAPH_MESSAGE_SELECT = 'id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,flag,from,toRecipients,ccRecipients,replyTo,changeKey,parentFolderId,internetMessageHeaders';
/**
 * Preferred Graph delta response size.
 *
 * Do not pass this as `$top` to `/messages/delta`. Microsoft documents
 * `Prefer: odata.maxpagesize={x}` as the request-level page-size control for
 * delta synchronization. In practice `$top` on the delta endpoint has also had
 * provider-side behaviours where a round can terminate at the requested count,
 * which is disastrous for an initial historical import because Inboxora would
 * persist that premature deltaLink as if the whole folder had been traversed.
 *
 * 200 keeps the payload bounded (internetMessageHeaders can make one message
 * fairly large) while still making the initial baseline efficient.
 */
export const MESSAGE_PAGE_SIZE = 200;

export interface GraphMessagePage {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * The `uid` a Graph message gets in the local row.
 *
 * `messages.uid` is `BIGINT NOT NULL` and historically the IMAP UID, so a Graph
 * message needs *a* number. Deriving it from the provider id by hash keeps it
 * stable across runs — which is what the column's `UNIQUE (account_id, uid, folder)`
 * needs — while the real identity lives in `provider_message_id`. The digest is
 * truncated to 63 bits and never zero, and `attempt` lets the caller resolve the
 * astronomically unlikely collision with another message's number.
 */
export function providerUidForGraphMessage(id: string, attempt = 0): string {
  const digest = createHash('sha256').update(attempt === 0 ? id : `${id}#${attempt}`).digest();
  let value = BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & ((1n << 63n) - 1n);
  if (value === 0n) value = 1n;
  return value.toString();
}

function addresses(recipients: readonly GraphRecipient[] | null | undefined): Array<{ name: string | null; address: string }> {
  const result: Array<{ name: string | null; address: string }> = [];
  for (const recipient of recipients ?? []) {
    const address = recipient?.emailAddress?.address?.trim();
    if (!address) continue;
    result.push({ name: recipient.emailAddress?.name?.trim() || null, address });
  }
  return result;
}

function parseGraphDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function graphHeaderMap(headers: GraphMessage['internetMessageHeaders']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers ?? []) {
    const name = header?.name?.trim().toLowerCase();
    if (!name || Object.hasOwn(result, name)) continue;
    result[name] = header?.value ?? '';
  }
  return result;
}

/** Header values are optional metadata; blanks must not erase a previously hydrated value. */
function normalizedUnsubscribeHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  return headers[name]?.trim() || null;
}

/** Project one Graph message. `null` for an entry that is a deletion or has no id. */
export function localMessageForGraphMessage(message: GraphMessage): LocalGraphMessage | null {
  if (!message.id || message['@removed']) return null;
  const from = message.from?.emailAddress;
  const parsedHeaders = graphHeaderMap(message.internetMessageHeaders);
  return {
    uid: providerUidForGraphMessage(message.id),
    providerMessageId: message.id,
    messageId: message.internetMessageId?.trim() || null,
    threadId: message.conversationId?.trim() || null,
    subject: message.subject ?? null,
    fromName: from?.name?.trim() || null,
    fromEmail: from?.address?.trim() || null,
    toAddresses: addresses(message.toRecipients),
    ccAddresses: addresses(message.ccRecipients),
    replyTo: addresses(message.replyTo),
    parsedHeaders,
    listUnsubscribe: normalizedUnsubscribeHeader(parsedHeaders, 'list-unsubscribe'),
    listUnsubscribePost: normalizedUnsubscribeHeader(parsedHeaders, 'list-unsubscribe-post'),
    parsedHeadersComplete: Array.isArray(message.internetMessageHeaders),
    date: parseGraphDate(message.receivedDateTime) ?? parseGraphDate(message.sentDateTime),
    snippet: message.bodyPreview ?? null,
    isRead: Boolean(message.isRead),
    isStarred: (message.flag?.flagStatus ?? '').toLowerCase() === 'flagged',
    hasAttachments: Boolean(message.hasAttachments),
    isDraft: Boolean(message.isDraft),
  };
}

/**
 * Read one page of a folder's message delta, resuming from `nextLink` first and
 * falling back to the stored `deltaLink`, exactly as Graph issued them.
 */

/**
 * Resolve the current mailbox location of one message.
 *
 * In ImmutableId mode the id survives a move between folders in the same
 * mailbox. Therefore:
 * - a returned parentFolderId proves the message still exists;
 * - RESOURCE_NOT_FOUND proves the immutable item is no longer present.
 */

/**
 * Find the current Graph representation of a message by its RFC Internet
 * Message-ID.
 *
 * Default Graph message ids are not durable enough to prove deletion. The
 * Internet Message-ID gives tombstone reconciliation an independent identity.
 * Multiple matches are returned rather than guessed between: ambiguity must
 * never authorize a destructive local delete.
 */
export async function findGraphMessagesByInternetMessageId(
  api: GraphApiOptions,
  internetMessageId: string,
): Promise<GraphMessage[]> {
  const normalized = internetMessageId.trim();
  if (!normalized) return [];

  // OData string literals escape a quote by doubling it. URL encoding itself is
  // handled by graphUrl/URLSearchParams.
  const escaped = normalized.replace(/'/g, "''");

  const page = await graphGet<GraphMessagePage>(
    api,
    graphUrl('/me/messages', {
      $select: GRAPH_MESSAGE_SELECT,
      $filter: `internetMessageId eq '${escaped}'`,
      $top: 5,
    }),
  );

  return (page.value ?? []).filter(
    (message): message is GraphMessage => typeof message.id === 'string' && message.id.length > 0,
  );
}

export async function fetchGraphMessageLocation(
  api: GraphApiOptions,
  providerMessageId: string,
): Promise<{ id: string; parentFolderId: string | null } | null> {
  try {
    const message = await graphGet<{ id?: string | null; parentFolderId?: string | null }>(
      api,
      graphUrl(`/me/messages/${encodeURIComponent(providerMessageId)}`, {
        $select: 'id,parentFolderId',
      }),
    );

    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) return null;

    return {
      id,
      parentFolderId: typeof message.parentFolderId === 'string'
        ? message.parentFolderId
        : null,
    };
  } catch (caught) {
    if (caught instanceof GraphApiError && caught.code === 'RESOURCE_NOT_FOUND') {
      return null;
    }
    throw caught;
  }
}

export async function fetchMessagesDeltaPage(api: GraphApiOptions, input: {
  folderId: string;
  nextLink?: string | null;
  deltaLink?: string | null;
  top?: number;
}): Promise<{ messages: GraphMessage[]; nextLink: string | null; deltaLink: string | null }> {
  const requestedPageSize = Number.isFinite(input.top)
    ? Math.max(1, Math.min(1000, Math.trunc(Number(input.top))))
    : MESSAGE_PAGE_SIZE;
  const url = input.nextLink
    ?? input.deltaLink
    ?? graphUrl(`/me/mailFolders/${encodeURIComponent(input.folderId)}/messages/delta`, {
      $select: GRAPH_MESSAGE_SELECT,
    });
  // Keep the provider-issued nextLink/deltaLink completely opaque. Query options
  // are encoded into those links by Graph; the page-size preference is a request
  // header and therefore must be repeated on every request in the round.
  const page = await graphGetWithHeaders<GraphMessagePage>(api, url, {
    Prefer: `odata.maxpagesize=${requestedPageSize}`,
  });
  return {
    messages: page.value ?? [],
    nextLink: page['@odata.nextLink'] ?? null,
    deltaLink: page['@odata.deltaLink'] ?? null,
  };
}
