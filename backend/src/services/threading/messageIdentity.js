import { normalizeMessageId } from './normalizeMessageId.js';

export function messageIdentity(message, { accountId } = {}) {
  const id = normalizeMessageId(message?.messageId || message?.message_id);
  return {
    accountId: accountId ?? message?.accountId ?? message?.account_id ?? null,
    messageId: id,
    fallbackId: message?.id ?? null,
  };
}
