// Native thread endpoints normally return one canonical physical copy for each
// normalized mail. Keep the UI defensive: older/provider responses can still contain
// duplicate physical copies of the same RFC Message-ID. Membership, expansion and
// thread-scope actions must all use this one definition.
type NativeThreadMember = {
  id?: unknown;
  message_id?: unknown;
  messageId?: unknown;
};

function membershipKey(message: NativeThreadMember): string {
  const messageId = String(message.message_id || message.messageId || '').trim().toLowerCase();
  return messageId ? `message-id:${messageId}` : `physical:${String(message.id || '')}`;
}

function isNativeThreadMember(value: unknown): value is NativeThreadMember {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function normalizedNativeThreadMembers<T>(messages: readonly T[] | null | undefined | false | 0 | ''): T[] {
  const members = new Map<string, T>();
  if (messages === null || messages === undefined || messages === false || messages === 0 || messages === '') return [];
  for (const message of messages) {
    if (!isNativeThreadMember(message) || !message.id) continue;
    const key = membershipKey(message);
    if (!members.has(key)) members.set(key, message);
  }
  return Array.from(members.values());
}

export function isExpandableNativeThread<T>(messages: readonly T[] | null | undefined | false | 0 | ''): boolean {
  return normalizedNativeThreadMembers(messages).length > 1;
}

export function singletonNativeThreadTarget<T>(row: T | null | undefined, normalizedMembers: readonly T[]): T | null {
  if (isNativeThreadMember(row)) {
    for (const member of normalizedMembers) {
      if (isNativeThreadMember(member) && String(member.id) === String(row.id)) return member;
    }
  }
  if (row) return row;
  return normalizedMembers[0] || null;
}
