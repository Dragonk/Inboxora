import { normalizeMessageId } from './normalizeMessageId.js';

export function buildThreadGraph(messages = []) {
  const nodes = new Map();
  const duplicates = [];
  for (const message of messages) {
    const id = normalizeMessageId(message?.messageId || message?.message_id);
    if (!id) continue;
    if (nodes.has(id)) duplicates.push({ id, existing: nodes.get(id), duplicate: message });
    else nodes.set(id, { ...message, messageId: id });
  }

  const parentById = new Map();
  for (const message of nodes.values()) {
    const references = Array.isArray(message.references)
      ? message.references.map(normalizeMessageId).filter(Boolean)
      : [];
    const inReplyTo = normalizeMessageId(message.inReplyTo || message.in_reply_to);
    const candidates = [...(inReplyTo ? [inReplyTo] : []), ...references].filter(Boolean);
    const parent = [...candidates].reverse().find(candidate => candidate !== message.messageId) || null;
    if (parent) parentById.set(message.messageId, parent);
  }
  return { nodes, parentById, duplicates };
}

export function findThreadRoot(messageId, graph, maxDepth = 100) {
  let current = normalizeMessageId(messageId);
  const seen = new Set();
  for (let depth = 0; current && depth < maxDepth; depth++) {
    if (seen.has(current)) return [...seen].sort()[0] || current;
    seen.add(current);
    const parent = graph?.parentById?.get(current);
    if (!parent || !graph.nodes.has(parent)) return current;
    current = parent;
  }
  return current;
}
