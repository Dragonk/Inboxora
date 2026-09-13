// Native thread endpoints normally return one canonical physical copy for each
// normalized mail. Keep the UI defensive: older/provider responses can still contain
// duplicate physical copies of the same RFC Message-ID. Membership, expansion and
// thread-scope actions must all use this one definition.
function membershipKey(message) {
  const messageId = String(message?.message_id || message?.messageId || '').trim().toLowerCase();
  return messageId ? `message-id:${messageId}` : `physical:${String(message?.id || '')}`;
}

export function normalizedNativeThreadMembers(messages) {
  const members = new Map();
  for (const message of messages || []) {
    if (!message?.id) continue;
    const key = membershipKey(message);
    if (!members.has(key)) members.set(key, message);
  }
  return [...members.values()];
}

export function isExpandableNativeThread(messages) {
  return normalizedNativeThreadMembers(messages).length > 1;
}

export function singletonNativeThreadTarget(row, normalizedMembers) {
  return normalizedMembers.find(member => String(member.id) === String(row?.id))
    || row
    || normalizedMembers[0]
    || null;
}
