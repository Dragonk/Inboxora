/** A physical message copy as the conversation adapter reads it. */
export interface ConversationCopyLike {
  id?: string;
  date?: string | number | Date | null;
  messageDate?: string | number | Date | null;
  accountId?: string | null;
  account_id?: string | null;
  folder?: string;
  messageId?: string | null;
  message_id?: string;
  subject?: string;
  has_attachments?: boolean;
  attachments?: unknown[] | null;
  fromName?: string;
  from_name?: string;
  [key: string]: unknown;
}

/** The logical message a copy belongs to. */
export interface LogicalMessageLike {
  id?: string;
  canonicalMessageId?: string;
  canonical_message_id?: string;
  subject?: string;
  [key: string]: unknown;
}

/** A logical message that carries the physical copies the adapter reads through. */
export interface ConversationLogicalMessageLike extends LogicalMessageLike {
  id: string;
  copies?: ConversationCopyLike[];
}

/** The summary block of a conversation detail payload. */
interface ConversationSummaryLike {
  id?: string;
  conversation_id?: string;
  account_id?: string;
  accountId?: string;
  [key: string]: unknown;
}

/** The conversation detail payload consumed by the thread adapter. */
export interface ConversationDetailLike {
  summary?: ConversationSummaryLike | null;
  logicalMessages?: ConversationLogicalMessageLike[] | null;
  [key: string]: unknown;
}

/** A logical-message row nested inside a conversation list row. */
interface ConversationRowLogicalLike {
  id?: string;
  latestCopyId?: string;
  isLatest?: boolean;
  accountId?: string;
  subject?: string;
  canonicalSubject?: string;
  fromName?: string;
  fromEmail?: string;
  snippet?: string;
  messageDate?: string | number | Date | null;
  folder?: string;
  hasAttachments?: boolean;
  [key: string]: unknown;
}

/** A conversation list row as the thread adapter reads it. */
interface ConversationRowLike {
  id?: string;
  conversation_id?: string;
  logical_messages?: ConversationRowLogicalLike[] | null;
  logicalMessages?: ConversationRowLogicalLike[] | null;
  latest_copy_id?: string;
  latestCopyId?: string;
  logical_message_count?: number;
  account_id?: string;
  copy_count?: number;
  visible_copy_count?: number;
  unread_count?: number;
  is_starred?: boolean;
  latest_copy_is_starred?: boolean;
  canonical_subject?: string;
  subject?: string;
  from_name?: string;
  from_email?: string;
  snippet?: string;
  date?: string | number | Date | null;
  last_message_at?: string | number | Date | null;
  folder?: string;
  has_attachments?: boolean;
  latest_copy_has_attachments?: boolean;
  [key: string]: unknown;
}

/** The conversation list payload consumed by the thread adapter. */
interface ConversationListLike {
  conversations?: ConversationRowLike[] | null;
  [key: string]: unknown;
}

/** A native /mail/thread/:threadId child record. */
interface NativeThreadMessageLike {
  id: string;
  message_id?: string;
  subject?: string;
  date?: string | number | Date | null;
  snippet?: string;
  is_read?: boolean;
  is_starred?: boolean;
  has_attachments?: boolean;
  account_id?: string;
  thread_id?: string;
  thread_key?: string;
  folder?: string;
  from_name?: string;
  from_email?: string;
  to_addresses?: unknown;
  cc_addresses?: unknown;
  delivery_addresses?: unknown;
  list_unsubscribe?: unknown;
  unsubscribed_at?: unknown;
  [key: string]: unknown;
}

/** A logical message with its copies, as ConversationMessage consumes it. */
export interface ReaderMessageLike extends ConversationLogicalMessageLike {
  subject?: string;
  canonicalMessageId?: string;
  canonical_message_id?: string;
  messageDate?: string | number | Date | null;
  message_date?: string | number | Date | null;
  snippet?: string;
  unread?: boolean;
  copies: ConversationCopyLike[];
  _nativeIndex?: number;
  _ceMatched?: boolean;
}

function copyDate(copy: ConversationCopyLike): number {
  const raw = copy?.date ?? copy?.messageDate ?? 0;
  const value = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(value) ? value : 0;
}

export function preferredConversationCopy(copies: ConversationCopyLike[] | null | undefined, accountId: string | null | undefined, selectedFolder: string | null | undefined): ConversationCopyLike | null {
  const sameAccount = (copies || []).filter(copy => String(copy.accountId ?? copy.account_id) === String(accountId));
  return sameAccount.sort((left, right) => {
    const rank = (copy: ConversationCopyLike) => {
      const folder = String(copy.folder || '');
      if (selectedFolder && folder === selectedFolder) return 0;
      if (folder === 'INBOX') return 1;
      if (folder.toLowerCase() === 'sent') return 2;
      return 3;
    };
    return rank(left) - rank(right) || copyDate(right) - copyDate(left) || String(right.id).localeCompare(String(left.id));
  })[0] || null;
}

function nativeCopy(copy: ConversationCopyLike, logical: LogicalMessageLike, conversationId: string | null | undefined, accountId: string | null | undefined) {
  return {
    ...copy,
    id: copy.id,
    account_id: copy.accountId ?? copy.account_id ?? accountId,
    conversation_id: conversationId,
    logical_message_id: logical.id,
    thread_id: conversationId,
    message_id: copy.messageId ?? copy.message_id ?? logical.canonicalMessageId ?? logical.canonical_message_id,
    subject: copy.subject ?? logical.subject,
    from_name: copy.fromName ?? copy.from_name,
    from_email: copy.fromEmail ?? copy.from_email,
    to_addresses: copy.to ?? copy.to_addresses ?? [],
    cc_addresses: copy.cc ?? copy.cc_addresses ?? [],
    date: copy.date ?? logical.messageDate ?? logical.message_date,
    snippet: copy.snippet ?? logical.snippet,
    is_read: copy.isRead ?? copy.is_read ?? !logical.unread,
    is_starred: copy.isStarred ?? copy.is_starred ?? false,
    has_attachments: copy.hasAttachments ?? copy.has_attachments ?? Boolean(copy.attachments?.length),
  };
}

export function conversationDetailToThreadMessages(detail: ConversationDetailLike | null | undefined, selectedFolder: string | null | undefined) {
  const conversationId = detail?.summary?.conversation_id ?? detail?.summary?.id;
  const accountId = detail?.summary?.account_id ?? detail?.summary?.accountId;
  return (detail?.logicalMessages || []).map((logical: ConversationLogicalMessageLike) => {
    const copy = preferredConversationCopy(logical.copies, accountId, selectedFolder);
    return copy ? nativeCopy(copy, logical, conversationId, accountId) : null;
  }).filter(Boolean);
}

export function conversationRowToThreadRow(row: ConversationRowLike) {
  const logicalMessages = row.logical_messages || row.logicalMessages || [];
  const latestCopyId = row.latest_copy_id || row.latestCopyId;
  const latest: ConversationRowLogicalLike = logicalMessages.find(item => item.latestCopyId === latestCopyId)
    || logicalMessages.find(item => item.isLatest)
    || logicalMessages.at(-1)
    || {};
  const conversationId = row.conversation_id || row.id;
  const logicalCount = Number(row.logical_message_count ?? logicalMessages.length ?? 0);
  return {
    ...row,
    id: latestCopyId || latest.latestCopyId || conversationId,
    conversation_id: conversationId,
    account_id: row.account_id ?? latest.accountId,
    latest_copy_id: latestCopyId || latest.latestCopyId || null,
    logical_message_count: logicalCount,
    copy_count: Number(row.copy_count ?? row.visible_copy_count ?? 0),
    thread_id: conversationId,
    message_count: logicalCount,
    unread_count: Number(row.unread_count || 0),
    is_read: Number(row.unread_count || 0) === 0,
    is_starred: row.is_starred ?? row.latest_copy_is_starred ?? false,
    subject: row.canonical_subject || row.subject || latest.subject,
    canonical_subject: row.canonical_subject || latest.canonicalSubject,
    from_name: row.from_name ?? latest.fromName,
    from_email: row.from_email ?? latest.fromEmail,
    snippet: row.snippet ?? latest.snippet,
    date: row.date || row.last_message_at || latest.messageDate,
    folder: row.folder || latest.folder,
    has_attachments: row.has_attachments ?? row.latest_copy_has_attachments ?? latest.hasAttachments ?? false,
    logical_messages: logicalMessages,
  };
}

export function conversationListToThreadRows(data: ConversationListLike | null | undefined) {
  return (data?.conversations || []).map(conversationRowToThreadRow);
}

/** Whether a raw native thread child carries a physical copy id. */
function isNativeThreadMessage(value: unknown): value is NativeThreadMessageLike {
  if (!value || typeof value !== 'object' || !('id' in value)) return false;
  return Boolean(value.id);
}

/**
 * Map native /mail/thread/:threadId children to the logical-message-with-copies shape
 * that ConversationMessage consumes. Each unique physical message becomes one reader
 * card. This is the fallback/primary source when CE graph is incomplete so the reader
 * never silently drops messages that the native thread list shows.
 *
 * Native thread children are already deduplicated by message_id by the backend
 * (DISTINCT ON), so one row here = one unique real message.
 */
export function nativeThreadToReaderMessages(threadMessages: unknown, accountId: string | null | undefined): ReaderMessageLike[] {
  const validMessages = Array.isArray(threadMessages)
    ? threadMessages.filter(isNativeThreadMessage)
    : [];
  return validMessages.map((msg: NativeThreadMessageLike, index: number) => ({
    id: msg.message_id || msg.id,
    subject: msg.subject,
    canonicalMessageId: msg.message_id,
    canonical_message_id: msg.message_id,
    messageDate: msg.date,
    message_date: msg.date,
    snippet: msg.snippet,
    unread: !msg.is_read,
    // Single copy: the native thread message is already the preferred physical copy.
    copies: [{
      id: msg.id,
      accountId: msg.account_id || accountId,
      account_id: msg.account_id || accountId,
      messageId: msg.message_id,
      message_id: msg.message_id,
      threadId: msg.thread_id,
      thread_id: msg.thread_id,
      threadKey: msg.thread_key,
      folder: msg.folder,
      subject: msg.subject,
      fromName: msg.from_name,
      from_name: msg.from_name,
      fromEmail: msg.from_email,
      from_email: msg.from_email,
      to: msg.to_addresses,
      to_addresses: msg.to_addresses,
      cc: msg.cc_addresses,
      cc_addresses: msg.cc_addresses,
      date: msg.date,
      snippet: msg.snippet,
      isRead: msg.is_read,
      is_read: msg.is_read,
      isStarred: msg.is_starred,
      is_starred: msg.is_starred,
      hasAttachments: msg.has_attachments,
      has_attachments: msg.has_attachments,
      attachments: [],
      deliveryAddresses: msg.delivery_addresses,
      delivery_addresses: msg.delivery_addresses,
      listUnsubscribe: msg.list_unsubscribe,
      list_unsubscribe: msg.list_unsubscribe,
      unsubscribedAt: msg.unsubscribed_at,
      unsubscribed_at: msg.unsubscribed_at,
    }],
    _nativeIndex: index,
    _ceMatched: false,
  }));
}

/**
 * Native-thread membership is authoritative. This is a LEFT JOIN from normalized
 * native children to CE metadata — never a union. CE-only/stale logical records are
 * intentionally invisible here and remain available only for diagnostics/rebuild.
 */
export function mergeThreadWithConversation(ceMessages: ConversationLogicalMessageLike[] | null | undefined, nativeMessages: ReaderMessageLike[] | null | undefined): ConversationLogicalMessageLike[] {
  if (!nativeMessages?.length) return ceMessages || [];
  if (!ceMessages?.length) return nativeMessages;
  const normalizedMessageId = (value: unknown) => String(value || '').trim().toLowerCase();
  const candidatesFor = (native: ReaderMessageLike, physicalCopyId: string | undefined, nativeAccountId: string | null | undefined) => (ceMessages || []).filter((logical: ConversationLogicalMessageLike) => {
    return (logical.copies || []).some((copy: ConversationCopyLike) => {
      if (String(copy.accountId ?? copy.account_id) !== String(nativeAccountId)) return false;
      if (String(copy.id) === String(physicalCopyId)) return true;
      const nativeMid = normalizedMessageId(native.canonicalMessageId || native.canonical_message_id);
      const ceMid = normalizedMessageId(copy.messageId || copy.message_id);
      return Boolean(nativeMid && ceMid && nativeMid === ceMid);
    });
  });
  return nativeMessages.map((native: ReaderMessageLike) => {
    const nativeCopy = native.copies?.[0];
    const physicalCopyId = nativeCopy?.id;
    const nativeAccountId = nativeCopy?.accountId ?? nativeCopy?.account_id;
    // Exact physical copy is strongest. Otherwise permit only a same-account normalized
    // RFC Message-ID match; ambiguous CE candidates receive no enrichment.
    const physicalCandidates = (ceMessages || []).filter((logical: ConversationLogicalMessageLike) => (logical.copies || []).some((copy: ConversationCopyLike) =>
      String(copy.accountId ?? copy.account_id) === String(nativeAccountId)
      && String(copy.id) === String(physicalCopyId)));
    const candidates = physicalCandidates.length ? physicalCandidates : candidatesFor(native, physicalCopyId, nativeAccountId);
    if (candidates.length !== 1) return native;
    const ce = candidates[0];
    const copies = native.copies.map((nativePhysicalCopy: ConversationCopyLike) => {
      const ceCopy = (ce.copies || []).find((copy: ConversationCopyLike) => String(copy.id) === String(nativePhysicalCopy.id)) || {};
      const definedNative = Object.fromEntries(Object.entries(nativePhysicalCopy)
        .filter(([, value]) => value != null && value !== ''));
      return { ...ceCopy, ...definedNative };
    });
    return { ...native, ...ce, copies, id: ce.id || native.id, _ceMatched: true };
  });
}
