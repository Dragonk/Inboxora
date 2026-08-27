export function initialConversationTarget(messages, targetLogicalMessageId) {
  const ids = (messages || []).map(message => message?.id).filter(Boolean);
  if (targetLogicalMessageId && ids.includes(targetLogicalMessageId)) return targetLogicalMessageId;
  return ids.at(-1) || null;
}

export function initialConversationExpansion(messages, targetLogicalMessageId) {
  const target = initialConversationTarget(messages, targetLogicalMessageId);
  return new Set(target ? [target] : []);
}

export function toggleConversationExpansion(expanded, logicalMessageId) {
  const next = new Set(expanded);
  if (next.has(logicalMessageId)) next.delete(logicalMessageId);
  else next.add(logicalMessageId);
  return next;
}
