import { createHash } from 'crypto';

function toScalar(value) {
  if (value === null || value === undefined) return null;
  const scalar = typeof value === 'bigint' ? String(value) : String(value);
  return scalar === '' || scalar.toUpperCase() === 'NIL' ? null : scalar;
}

export function providerNamespace({ provider, accountId, host }) {
  return [provider || 'generic', accountId || 'unknown-account', host || 'unknown-host'].join(':');
}

export function parseProviderMetadata(msg, account) {
  const attributes = msg?.attributes || msg || {};
  const host = String(account?.imap_host || '').toLowerCase();
  const provider = host.includes('gmail') ? 'gmail' : host.includes('outlook') || host.includes('office365') || host.includes('microsoft') ? 'outlook' : 'generic';
  // ImapFlow intentionally normalizes OBJECTID and X-GM-MSGID into `emailId`.
  // Keep that value provider-neutral; only the legacy xGm* aliases are explicitly
  // identified as Gmail extensions. This prevents OBJECTID from being mislabeled
  // as X-GM-MSGID while retaining compatibility with older fixtures.
  const msgId = attributes.emailId ?? attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid ?? null;
  const threadId = attributes.threadId ?? attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid ?? null;
  const safeMsgId = toScalar(msgId);
  const safeThreadId = toScalar(threadId);
  const legacyGmailMsgId = attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid;
  const legacyGmailThreadId = attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid;
  return {
    provider,
    accountId: account?.id || null,
    providerMessageId: safeMsgId,
    providerThreadId: safeThreadId,
    namespace: providerNamespace({ provider, accountId: account?.id, host: account?.imap_host }),
    source: safeThreadId ? (legacyGmailThreadId != null ? 'x-gm-thread' : 'provider-thread-id') : safeMsgId ? (legacyGmailMsgId != null ? 'x-gm-message' : 'provider-email-id') : null,
    isStrong: provider === 'gmail' && safeThreadId !== null,
    confidence: safeThreadId ? 1 : safeMsgId ? 0.8 : 0,
    diagnostics: {
      fingerprint: createHash('sha256').update([provider, safeMsgId || '', safeThreadId || ''].join('|')).digest('hex'),
      messageIdSource: legacyGmailMsgId != null ? 'x-gm-msgid-alias' : attributes.emailId != null ? 'imapflow-email-id' : null,
      threadIdSource: legacyGmailThreadId != null ? 'x-gm-thrid-alias' : attributes.threadId != null ? 'imapflow-thread-id' : null,
    },
  };
}

export function providerFetchQuery(account, base = {}) {
  const host = (account?.imap_host || '').toLowerCase();
  return host.includes('gmail') ? { ...base, headers: true, threadId: true } : { ...base };
}

export function normalizeProviderReferences(value) {
  if (value === null || value === undefined) return [];
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return [...new Set([...text.matchAll(/<[^<>\r\n]+>/g)].map(m => m[0]))];
}
