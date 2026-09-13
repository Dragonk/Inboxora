import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

export interface MessageReferencesInput {
  thread_references?: unknown;
  raw_references?: unknown;
  references?: unknown;
  in_reply_to?: unknown;
  raw_in_reply_to?: unknown;
  inReplyTo?: unknown;
}

export function referencesAnchor(message: MessageReferencesInput = {}) {
  const refs = normalizeMessageIdList(message.thread_references || message.raw_references || message.references);
  const reply = normalizeMessageIdList(message.in_reply_to || message.raw_in_reply_to || message.inReplyTo).at(-1);
  // Prefer the stable root from References; if absent, use the direct reply target.
  return refs[0] || reply || null;
}
