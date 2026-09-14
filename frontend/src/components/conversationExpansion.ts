function messageIds(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];

  const ids: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || !('id' in message)) continue;
    const { id } = message;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

export function initialConversationTarget(messages: unknown, targetLogicalMessageId: unknown): string | null {
  const ids = messageIds(messages);
  if (typeof targetLogicalMessageId === 'string' && targetLogicalMessageId && ids.includes(targetLogicalMessageId)) {
    return targetLogicalMessageId;
  }

  const newestId = ids.at(-1);
  return newestId === undefined ? null : newestId;
}

export function initialConversationExpansion(messages: unknown, targetLogicalMessageId: unknown): Set<string> {
  const target = initialConversationTarget(messages, targetLogicalMessageId);
  if (target === null) return new Set();
  return new Set([target]);
}

export function toggleConversationExpansion(expanded: ReadonlySet<string>, logicalMessageId: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(logicalMessageId)) next.delete(logicalMessageId);
  else next.add(logicalMessageId);
  return next;
}
