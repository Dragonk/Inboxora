function copyDate(copy) {
  const value = Date.parse(copy?.date || copy?.messageDate || 0);
  return Number.isFinite(value) ? value : 0;
}

export function preferredConversationCopy(copies, accountId, selectedFolder) {
  const sameAccount = (copies || []).filter(copy => String(copy.accountId ?? copy.account_id) === String(accountId));
  return sameAccount.sort((left, right) => {
    const rank = copy => {
      const folder = String(copy.folder || '');
      if (selectedFolder && folder === selectedFolder) return 0;
      if (folder === 'INBOX') return 1;
      if (folder.toLowerCase() === 'sent') return 2;
      return 3;
    };
    return rank(left) - rank(right) || copyDate(right) - copyDate(left) || String(right.id).localeCompare(String(left.id));
  })[0] || null;
}

function nativeCopy(copy, logical, conversationId, accountId) {
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

export function conversationDetailToThreadMessages(detail, selectedFolder) {
  const conversationId = detail?.summary?.conversation_id ?? detail?.summary?.id;
  const accountId = detail?.summary?.account_id ?? detail?.summary?.accountId;
  return (detail?.logicalMessages || []).map(logical => {
    const copy = preferredConversationCopy(logical.copies, accountId, selectedFolder);
    return copy ? nativeCopy(copy, logical, conversationId, accountId) : null;
  }).filter(Boolean);
}

export function conversationRowToThreadRow(row) {
  const logicalMessages = row.logical_messages || row.logicalMessages || [];
  const latestCopyId = row.latest_copy_id || row.latestCopyId;
  const latest = logicalMessages.find(item => item.latestCopyId === latestCopyId)
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

export function conversationListToThreadRows(data) {
  return (data?.conversations || []).map(conversationRowToThreadRow);
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
export function nativeThreadToReaderMessages(threadMessages, accountId) {
  return (threadMessages || []).map((msg, index) => ({
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
  }));
}

/**
 * Merge CE logical messages with native thread children. Native children are primary —
 * each unique real message gets a reader card. If CE has a matching logical identity
 * (by message_id), attach it for metadata enrichment. If CE does not yet contain a
 * member, the physical message still appears in the reader (never silently dropped).
 */
export function mergeThreadWithConversation(ceMessages, nativeMessages) {
  if (!nativeMessages?.length) return ceMessages || [];
  if (!ceMessages?.length) return nativeMessages;
  const ceByMessageId = new Map();
  for (const logical of ceMessages) {
    const mid = logical.canonicalMessageId || logical.canonical_message_id || logical.id;
    if (mid) ceByMessageId.set(mid, logical);
  }
  return nativeMessages.map(native => {
    const ce = ceByMessageId.get(native.id);
    if (!ce) return native;
    // Enrich native with CE logical identity but keep native copy (authoritative physical).
    return {
      ...native,
      ...ce,
      // Preserve native copies so the reader uses the real physical copy.
      copies: native.copies.length ? native.copies : ce.copies,
      id: ce.id || native.id,
    };
  });
}
