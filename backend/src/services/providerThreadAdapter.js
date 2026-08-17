import { createHash } from 'crypto';

function toScalar(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? String(value) : String(value);
}

export function providerNamespace({ provider, accountId, host }) {
  return [provider || 'generic', accountId || 'unknown-account', host || 'unknown-host'].join(':');
}

export function parseProviderMetadata(msg, account) {
  const attributes = msg?.attributes || msg || {};
  const host = String(account?.imap_host || '').toLowerCase();
  const provider = host.includes('gmail') ? 'gmail' : host.includes('outlook') || host.includes('office365') || host.includes('microsoft') ? 'outlook' : 'generic';
  const msgId = attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid ?? null;
  const threadId = attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid ?? null;
  const safeMsgId = toScalar(msgId);
  const safeThreadId = toScalar(threadId);
  return {
    provider,
    accountId: account?.id || null,
    providerMessageId: safeMsgId,
    providerThreadId: safeThreadId,
    namespace: providerNamespace({ provider, accountId: account?.id, host: account?.imap_host }),
    source: safeThreadId ? 'x-gm-thread' : safeMsgId ? 'x-gm-message' : null,
    isStrong: provider === 'gmail' && safeThreadId !== null,
    confidence: safeThreadId ? 1 : safeMsgId ? 0.8 : 0,
    diagnostics: { fingerprint: createHash('sha256').update([provider, safeMsgId || '', safeThreadId || ''].join('|')).digest('hex') },
  };
}

export function providerFetchQuery(account, base = {}) {
  const host = (account?.imap_host || '').toLowerCase();
  return host.includes('gmail') ? { ...base, headers: true } : { ...base };
}

export function normalizeProviderReferences(value) {
  if (value === null || value === undefined) return [];
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return [...new Set([...text.matchAll(/<[^<>\r\n]+>/g)].map(m => m[0]))];
}
