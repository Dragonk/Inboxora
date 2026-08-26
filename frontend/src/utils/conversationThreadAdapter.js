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
 * Merge CE logical messages with native thread children. CE logical identity is primary
 * when available (stable logical IDs, manual overrides). Native children supply the
 * authoritative physical copies and ensure messages CE has not yet ingested still appear.
 *
 * Matching: CE logical messages are indexed by the message_id of their copies AND by
 * their own canonicalMessageId/id. Native children are matched by their message_id.
 * If a CE logical message matches, the reader card uses the CE logical ID (so existing
 * UI contracts, resolver targets, and tests stay stable) but the native physical copy
 * is authoritative. Unmatched native children get a synthetic logical ID and remain
 * visible — never silently dropped.
 */
export function mergeThreadWithConversation(ceMessages, nativeMessages) {
  if (!nativeMessages?.length) return ceMessages || [];
  if (!ceMessages?.length) return nativeMessages;
  // Index CE logical messages by every message_id AND physical copy id found on their
  // copies, plus their own canonicalMessageId/id as fallbacks. Physical copy id is the
  // most reliable join key when CE and native use different message_id formats.
  const ceByMessageId = new Map();
  for (const logical of ceMessages) {
    const mids = new Set();
    const canonical = logical.canonicalMessageId || logical.canonical_message_id || logical.id;
    if (canonical) mids.add(canonical);
    for (const copy of (logical.copies || [])) {
      const cmid = copy.messageId || copy.message_id;
      if (cmid) mids.add(cmid);
      if (copy.id) mids.add(copy.id);
    }
    for (const mid of mids) ceByMessageId.set(mid, logical);
  }
  const usedCe = new Set();
  const result = nativeMessages.map(native => {
    // Match by native message_id (preferred) OR native physical copy id (fallback).
    const ce = ceByMessageId.get(native.id) || ceByMessageId.get(native.copies?.[0]?.id);
    if (ce) {
      usedCe.add(ce.id);
      // Keep native physical identity authoritative, while retaining CE-only display
      // metadata (e.g. snippet) when the legacy native thread endpoint does not send it.
      const copies = native.copies.map(nativeCopy => {
        const ceCopy = (ce.copies || []).find(copy => String(copy.id) === String(nativeCopy.id)) || {};
        const definedNative = Object.fromEntries(Object.entries(nativeCopy)
          .filter(([, value]) => value != null && value !== ''));
        return { ...ceCopy, ...definedNative };
      });
      // Use CE logical ID (stable identity for tests, resolver, expansion state).
      return {
        ...native,
        ...ce,
        copies,
        id: ce.id || native.id,
      };
    }
    // No CE match — synthetic logical ID so the message still appears in the reader.
    return native;
  });
  // Append CE logical messages that have no native match (e.g. CE ingested a message
  // the native thread endpoint no longer returns because it was deleted/moved).
  for (const ce of ceMessages) {
    if (!usedCe.has(ce.id)) result.push(ce);
  }
  return result;
}
