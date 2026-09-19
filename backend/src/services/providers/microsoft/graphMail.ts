import { createHash } from 'crypto';
import { graphGet, graphUrl } from './graphApiClient.js';
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
  /** Present on Outlook's well-known folders (`inbox`, `sentitems`, …). */
  wellKnownName?: string | null;
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

const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,wellKnownName';
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

/** The local folder a Graph folder projects onto. Pure, so it can be asserted directly. */
export function localFolderForGraphFolder(folder: GraphMailFolder, parentPath: string | null): LocalMailFolder {
  const name = (folder.displayName ?? '').trim() || folder.id;
  const wellKnown = folder.wellKnownName ? WELL_KNOWN_FOLDERS[folder.wellKnownName.toLowerCase()] : undefined;
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
 */
export function graphFolderPathMap(folders: readonly GraphMailFolder[]): Map<string, LocalMailFolder> {
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
    const local = localFolderForGraphFolder(folder, parentPath);
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
export async function fetchMailFolders(
  api: GraphApiOptions,
  options: { maxFolders?: number } = {},
): Promise<GraphMailFolder[]> {
  const maxFolders = options.maxFolders ?? MAX_MAIL_FOLDERS;
  const folders: GraphMailFolder[] = [];
  const queue: Array<{ id: string | null; depth: number }> = [{ id: null, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > MAX_FOLDER_DEPTH) continue;
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
        if (folders.length >= maxFolders) return folders;
        if ((folder.childFolderCount ?? 0) > 0) queue.push({ id: folder.id, depth: current.depth + 1 });
      }
      nextLink = page['@odata.nextLink'] ?? null;
    } while (nextLink);
  }
  return folders;
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
  date: Date | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  isDraft: boolean;
}

export const GRAPH_MESSAGE_SELECT = 'id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,flag,from,toRecipients,ccRecipients,replyTo,changeKey,parentFolderId';
/** The page size the message delta sync uses; exported so provider-side search asks for the same shape. */
export const MESSAGE_PAGE_SIZE = 50;

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

/** Project one Graph message. `null` for an entry that is a deletion or has no id. */
export function localMessageForGraphMessage(message: GraphMessage): LocalGraphMessage | null {
  if (!message.id || message['@removed']) return null;
  const from = message.from?.emailAddress;
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
export async function fetchMessagesDeltaPage(api: GraphApiOptions, input: {
  folderId: string;
  nextLink?: string | null;
  deltaLink?: string | null;
  top?: number;
}): Promise<{ messages: GraphMessage[]; nextLink: string | null; deltaLink: string | null }> {
  const url = input.nextLink
    ?? input.deltaLink
    ?? graphUrl(`/me/mailFolders/${encodeURIComponent(input.folderId)}/messages/delta`, {
      $select: GRAPH_MESSAGE_SELECT,
      $top: input.top ?? MESSAGE_PAGE_SIZE,
    });
  const page = await graphGet<GraphMessagePage>(api, url);
  return {
    messages: page.value ?? [],
    nextLink: page['@odata.nextLink'] ?? null,
    deltaLink: page['@odata.deltaLink'] ?? null,
  };
}
