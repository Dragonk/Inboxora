import { createHash } from 'crypto';
import { GMAIL_USER, gmailGet, gmailUrl } from './gmailApi.js';
import { googleApiJson } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { decodeMimeWords, parseMailboxList } from '../../messageParser.js';
import { primaryFolderPathForGmailLabels } from './gmailLabels.js';

/**
 * Gmail **message and thread** projection (P08, second slice).
 *
 * Gmail identifies a message by an opaque id that is immutable for the life of the
 * message, and a thread by another. Both are carried through unchanged:
 * `messages.provider_message_id` is the identity a sync reconciles on (migration
 * 0108's partial unique index), and the thread id goes into the *thread identity*
 * column as `provider_thread_id`, with the same `gmail:` namespace the IMAP path
 * uses for `X-GM-THRID` — so the conversation engine treats a Gmail API thread as
 * strong evidence, exactly as it does a Gmail IMAP one, and nothing about grouping
 * is re-invented here.
 *
 * `uid` stays the per-account compatibility number it has always been: `messages`
 * is `UNIQUE (account_id, uid, folder)` with `uid BIGINT NOT NULL`, so a Gmail
 * message needs *a* number. It is derived from the provider id, which makes it
 * stable across runs; the identity remains `provider_message_id`.
 *
 * Gmail returns a message's headers in `payload.headers` rather than as a raw
 * block, and its `internalDate` is the provider's own arrival time — both are read
 * here so the local row is projected from the provider's facts rather than from a
 * later body fetch.
 */

/** A header as Gmail returns it. */
export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

/** A MIME part as Gmail's `metadata` format returns it: structure and headers, no bodies. */
export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id: string;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  historyId?: string | null;
  /** Epoch milliseconds as a string, as Gmail sends it. */
  internalDate?: string | null;
  sizeEstimate?: number | null;
  payload?: GmailPart | null;
}

export interface GmailThread {
  id: string;
  historyId?: string | null;
  snippet?: string | null;
  messages?: GmailMessage[] | null;
}

export interface GmailMessageListEntry {
  id?: string | null;
  threadId?: string | null;
}

interface GmailMessageListPage {
  messages?: GmailMessageListEntry[] | null;
  nextPageToken?: string | null;
  resultSizeEstimate?: number | null;
}

interface GmailHistoryMessage {
  message?: { id?: string | null; threadId?: string | null } | null;
  labelIds?: string[] | null;
}

export interface GmailHistoryRecord {
  id?: string | null;
  messages?: Array<{ id?: string | null; threadId?: string | null }> | null;
  messagesAdded?: GmailHistoryMessage[] | null;
  messagesDeleted?: GmailHistoryMessage[] | null;
  labelsAdded?: GmailHistoryMessage[] | null;
  labelsRemoved?: GmailHistoryMessage[] | null;
}

export interface GmailHistoryPage {
  history?: GmailHistoryRecord[] | null;
  nextPageToken?: string | null;
  /** The mailbox history id *after* this page: the cursor to resume from. */
  historyId?: string | null;
}

/**
 * The headers the projector reads. Requested explicitly, because Gmail's `metadata`
 * format only returns the ones asked for — and asking for the address and threading
 * headers is what lets the row carry correspondents and thread onto an existing
 * conversation without fetching the body.
 */
export const GMAIL_METADATA_HEADERS: readonly string[] = Object.freeze([
  'From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References',
  'List-Unsubscribe', 'List-Unsubscribe-Post',
]);

export const GMAIL_MESSAGE_LIST_PAGE_SIZE = 500;
export const GMAIL_HISTORY_PAGE_SIZE = 500;

/** A message projected onto the local `messages` row. */
export interface LocalGmailMessage {
  /** Compatibility number; the identity is the provider id, not this. */
  uid: string;
  providerMessageId: string;
  /** The RFC `Message-ID` header, metadata only: never an identity. */
  messageId: string | null;
  /** The provider's thread id. */
  providerThreadId: string | null;
  /** The `gmail:` namespace the conversation engine keys provider identity on. */
  providerNamespace: string;
  /** The local `thread_id`, in the same `gmail:` form the IMAP path uses. */
  threadId: string | null;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  toAddresses: Array<{ name: string | null; address: string }>;
  ccAddresses: Array<{ name: string | null; address: string }>;
  replyTo: Array<{ name: string | null; address: string }>;
  /** Complete lower-cased header map for rule conditions. */
  parsedHeaders: Record<string, string>;
  /** RFC 2369 action references, normalized from Gmail metadata headers. */
  listUnsubscribe: string | null;
  /** RFC 8058 one-click declaration, normalized from Gmail metadata headers. */
  listUnsubscribePost: string | null;
  date: Date | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  isDraft: boolean;
  /** Every label id Gmail reports, kept because a Gmail message is in several places at once. */
  labels: string[];
  /** The primary local folder, or `null` when the message is archived. */
  folderPath: string | null;
}

/**
 * The `uid` a Gmail message gets in the local row.
 *
 * As on the Graph side: `messages.uid` is `BIGINT NOT NULL` and historically the
 * IMAP UID, so a Gmail message needs *a* number. Deriving it from the provider id
 * by hash keeps it stable across runs — which is what the column's legacy
 * `UNIQUE (account_id, uid, folder)` needs — while the real identity lives in
 * `provider_message_id`. The digest is truncated to 63 bits and never zero, and
 * `attempt` lets the caller resolve the astronomically unlikely collision.
 */
export function providerUidForGmailMessage(id: string, attempt = 0): string {
  const digest = createHash('sha256').update(attempt === 0 ? id : `${id}#${attempt}`).digest();
  let value = BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & ((1n << 63n) - 1n);
  if (value === 0n) value = 1n;
  return value.toString();
}

/**
 * The `provider_namespace` a Gmail API message carries.
 *
 * Gmail is the provider and the API host is what distinguishes this ingest path
 * from the IMAP one; both start with `gmail`, which is what the conversation layer
 * reads to treat a Gmail thread id as strong evidence. The account id is in the
 * middle for the same reason the IMAP namespace carries it: a provider id is only
 * unique within one account.
 */
export function gmailProviderNamespace(accountId: string, host = 'gmail.googleapis.com'): string {
  return ['gmail', accountId || 'unknown-account', host].join(':');
}

/** `name: value` headers of a message, lowercased by name, first occurrence winning. */
export function gmailHeaderMap(message: GmailMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const name = header?.name?.trim().toLowerCase();
    if (!name || headers.has(name)) continue;
    headers.set(name, header?.value ?? '');
  }
  return headers;
}

/** Whether any MIME part names a file, which is what "has attachments" means here. */
export function gmailMessageHasAttachments(part: GmailPart | null | undefined): boolean {
  if (!part) return false;
  if ((part.filename ?? '').trim().length > 0) return true;
  for (const child of part.parts ?? []) {
    if (gmailMessageHasAttachments(child)) return true;
  }
  return false;
}

/** Gmail's `internalDate` (epoch milliseconds) parsed, else the `Date` header. */
function gmailMessageDate(message: GmailMessage, headers: ReadonlyMap<string, string>): Date | null {
  const internal = message.internalDate ? Number(message.internalDate) : Number.NaN;
  if (Number.isFinite(internal) && internal > 0) return new Date(internal);
  const header = headers.get('date');
  if (!header) return null;
  const parsed = new Date(header);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const addresses = (value: string | undefined): Array<{ name: string | null; address: string }> =>
  parseMailboxList(value ?? '').map(entry => ({ name: entry.name || null, address: entry.email }));

/**
 * Project one Gmail message.
 *
 * `pathByLabelId` is the account's folder-bearing label map, so a message's primary
 * folder is derived from the same canonical paths the folder slice created.
 */
export function localMessageForGmailMessage(
  message: GmailMessage,
  options: { accountId: string; pathByLabelId: ReadonlyMap<string, string>; host?: string },
): LocalGmailMessage | null {
  if (!message.id) return null;
  const headers = gmailHeaderMap(message);
  const labels = (message.labelIds ?? []).filter(label => typeof label === 'string' && label.length > 0);
  const providerThreadId = message.threadId?.trim() || null;
  const fromList = addresses(headers.get('from'));
  const from = fromList[0];
  return {
    uid: providerUidForGmailMessage(message.id),
    providerMessageId: message.id,
    messageId: headers.get('message-id')?.trim() || null,
    providerThreadId,
    providerNamespace: gmailProviderNamespace(options.accountId, options.host),
    threadId: providerThreadId ? `gmail:${providerThreadId}` : null,
    subject: decodeMimeWords(headers.get('subject') ?? '').trim() || null,
    fromName: from?.name ?? null,
    fromEmail: from?.address ?? null,
    toAddresses: addresses(headers.get('to')),
    ccAddresses: addresses(headers.get('cc')),
    replyTo: addresses(headers.get('reply-to')),
    parsedHeaders: Object.fromEntries(headers),
    listUnsubscribe: decodeMimeWords(headers.get('list-unsubscribe') ?? '').trim() || null,
    listUnsubscribePost: decodeMimeWords(headers.get('list-unsubscribe-post') ?? '').trim() || null,
    date: gmailMessageDate(message, headers),
    snippet: message.snippet ?? null,
    // Gmail's only unread marker is the `UNREAD` label.
    isRead: !labels.includes('UNREAD'),
    isStarred: labels.includes('STARRED'),
    hasAttachments: gmailMessageHasAttachments(message.payload),
    isDraft: labels.includes('DRAFT'),
    labels,
    folderPath: primaryFolderPathForGmailLabels(labels, options.pathByLabelId),
  };
}

/** Read one page of a label's message list. */
export async function fetchGmailMessageIds(
  api: GoogleApiOptions,
  input: { labelId?: string | null; pageToken?: string | null; maxResults?: number; includeSpamTrash?: boolean },
): Promise<{ messages: GmailMessageListEntry[]; nextPageToken: string | null }> {
  const page = await gmailGet<GmailMessageListPage>(api, `users/${GMAIL_USER}/messages`, {
    ...(input.labelId ? { labelIds: input.labelId } : {}),
    maxResults: input.maxResults ?? GMAIL_MESSAGE_LIST_PAGE_SIZE,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    ...(input.includeSpamTrash ? { includeSpamTrash: true } : {}),
  });
  return { messages: page.messages ?? [], nextPageToken: page.nextPageToken ?? null };
}

/** Read one message. `metadata` is the cheap shape the projector reads. */
export async function fetchGmailMessage(
  api: GoogleApiOptions,
  messageId: string,
  format: 'metadata' | 'full' | 'raw' = 'metadata',
): Promise<GmailMessage | null> {
  return googleApiJson<GmailMessage>(api, gmailUrl(`users/${GMAIL_USER}/messages/${encodeURIComponent(messageId)}`, {
    format,
    ...(format === 'metadata' ? { metadataHeaders: GMAIL_METADATA_HEADERS } : {}),
  }), { method: 'GET' });
}

/**
 * Read one thread with **every** message it contains.
 *
 * The history feed names the thread that changed rather than the exact set of
 * messages, and a thread fetch is one call for all of them; reconciling a thread as
 * a unit is also what keeps a label change (a message that left a mailbox) from
 * being applied to only part of the thread.
 */
export async function fetchGmailThread(
  api: GoogleApiOptions,
  threadId: string,
  format: 'metadata' | 'full' | 'minimal' = 'metadata',
): Promise<GmailThread | null> {
  return googleApiJson<GmailThread>(api, gmailUrl(`users/${GMAIL_USER}/threads/${encodeURIComponent(threadId)}`, {
    format,
    ...(format === 'metadata' ? { metadataHeaders: GMAIL_METADATA_HEADERS } : {}),
  }), { method: 'GET' });
}

/** The mailbox's current history id, captured before a baseline so nothing is skipped. */
export async function fetchGmailProfileHistoryId(api: GoogleApiOptions): Promise<string | null> {
  const profile = await gmailGet<{ historyId?: string | null }>(api, `users/${GMAIL_USER}/profile`);
  return profile.historyId ?? null;
}

/** Read one page of the mailbox history after `startHistoryId`. */
export async function fetchGmailHistoryPage(
  api: GoogleApiOptions,
  input: { startHistoryId: string; pageToken?: string | null; labelId?: string | null; maxResults?: number },
): Promise<GmailHistoryPage> {
  const page = await gmailGet<GmailHistoryPage>(api, `users/${GMAIL_USER}/history`, {
    startHistoryId: input.startHistoryId,
    maxResults: input.maxResults ?? GMAIL_HISTORY_PAGE_SIZE,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    ...(input.labelId ? { labelId: input.labelId } : {}),
  });
  return { history: page.history ?? [], nextPageToken: page.nextPageToken ?? null, historyId: page.historyId ?? null };
}

/**
 * The threads and removed messages one history record set names.
 *
 * A label change, an addition and a deletion are all "this thread changed" for the
 * purpose of re-reading it, because the projector derives the folder from the
 * message's **current** label set. A deletion is the one thing a re-read cannot
 * observe — the message is gone — so its id is returned separately.
 */
export function gmailHistoryChanges(records: readonly GmailHistoryRecord[]): {
  threadIds: string[];
  deletedMessageIds: string[];
} {
  const threads = new Set<string>();
  const deleted = new Set<string>();
  const note = (entry: { id?: string | null; threadId?: string | null } | null | undefined) => {
    const threadId = entry?.threadId?.trim();
    if (threadId) threads.add(threadId);
  };
  for (const record of records) {
    for (const message of record.messages ?? []) note(message);
    for (const added of record.messagesAdded ?? []) note(added?.message);
    for (const added of record.labelsAdded ?? []) note(added?.message);
    for (const removed of record.labelsRemoved ?? []) note(removed?.message);
    for (const removed of record.messagesDeleted ?? []) {
      const messageId = removed?.message?.id?.trim();
      if (messageId) deleted.add(messageId);
      note(removed?.message);
    }
  }
  return { threadIds: [...threads], deletedMessageIds: [...deleted] };
}
