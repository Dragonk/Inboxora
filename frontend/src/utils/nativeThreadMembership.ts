// A provider copy is actionable by physical ID; an RFC header is not an identity.
type NativeThreadMember = {
  id?: unknown;
  message_id?: unknown;
  messageId?: unknown;
  logical_message_id?: unknown;
  logicalMessageId?: unknown;
  account_id?: unknown;
};

function membershipKey(message: NativeThreadMember): string {
  return `physical:${String(message.account_id || '')}:${String(message.id || '')}`;
}

function displayMembershipKey(message: NativeThreadMember): string {
  const account = String(message.account_id || '');
  const logicalMessageId = String(message.logical_message_id || message.logicalMessageId || '').trim();
  if (logicalMessageId) return `logical:${account}:${logicalMessageId}`;
  const messageId = String(message.message_id || message.messageId || '').trim().toLowerCase();
  if (messageId) return `message-id:${account}:${messageId}`;
  return membershipKey(message);
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

/**
 * Collapse physical folder/provider copies into one row for thread presentation.
 * Action membership deliberately remains physical via normalizedNativeThreadMembers().
 */
export function normalizedNativeThreadDisplayMembers<T>(messages: readonly T[] | null | undefined | false | 0 | ''): T[] {
  const members = new Map<string, T>();
  if (messages === null || messages === undefined || messages === false || messages === 0 || messages === '') return [];
  for (const message of messages) {
    if (!isNativeThreadMember(message) || !message.id) continue;
    const key = displayMembershipKey(message);
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

/** A cached expansion is usable only while it still covers the current list row. */
export function nativeThreadCacheMatchesRow(
  row: NativeThreadMember & { message_count?: unknown },
  cached: readonly NativeThreadMember[] | null | undefined,
): boolean {
  if (!Array.isArray(cached) || cached.length === 0) return false;
  const members = normalizedNativeThreadMembers(cached);
  const expected = Number(row.message_count);
  if (Number.isFinite(expected) && expected > 0 && members.length !== expected) return false;
  if (row.account_id && members.some(member => member.account_id && member.account_id !== row.account_id)) return false;
  // The representative can change after a read/filter refresh or provider move.
  // The exact physical head must still be a member.
  return members.some(member => membershipKey(member) === membershipKey(row));
}

/** Pagination only deduplicates the same physical ID within its account. */
export function missingPhysicalMessages<T extends NativeThreadMember>(existing: readonly T[], incoming: readonly T[]): T[] {
  const present = new Set(existing.map(membershipKey));
  return normalizedNativeThreadMembers(incoming).filter(row => !present.has(membershipKey(row)));
}
export function appendPhysicalMessages<T extends NativeThreadMember>(existing: T[], incoming: readonly T[]): T[] {
  const missing = missingPhysicalMessages(existing, incoming);
  return missing.length ? [...existing, ...missing] : existing;
}
