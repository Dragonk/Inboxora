import { normalizeMessageId } from './normalizeMessageId.js';
import { buildThreadGraph, findThreadRoot } from './threadGraph.js';

export function normalizedSubject(subject = '') {
  return String(subject)
    .replace(/^\s*((re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

export function computeThreadKey(message, messages = []) {
  const id = normalizeMessageId(message?.messageId || message?.message_id);
  if (id) {
    const all = messages.length ? messages : [message];
    const graph = buildThreadGraph(all);
    return findThreadRoot(id, graph) || id;
  }

  // Subject-only messages have no reliable RFC relationship. Return null so the
  // persistence layer can keep them isolated or apply an explicitly scoped heuristic.
  return null;
}
