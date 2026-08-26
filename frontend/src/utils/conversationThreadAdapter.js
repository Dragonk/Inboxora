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
