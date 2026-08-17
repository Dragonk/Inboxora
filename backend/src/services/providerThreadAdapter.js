export function providerNamespace({ provider, accountId, host }) {
  return [provider || 'generic', accountId || 'unknown-account', host || 'unknown-host'].join(':');
}

export function parseProviderMetadata(msg, account) {
  const attributes = msg?.attributes || msg || {};
  const provider = (account?.imap_host || '').toLowerCase().includes('gmail') ? 'gmail' : 'generic';
  const msgId = attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid ?? null;
  const threadId = attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid ?? null;
  return {
    provider,
    accountId: account?.id || null,
    providerMessageId: msgId == null ? null : String(msgId),
    providerThreadId: threadId == null ? null : String(threadId),
    namespace: providerNamespace({ provider, accountId: account?.id, host: account?.imap_host }),
    source: msgId || threadId ? 'x-gm' : null,
    confidence: msgId || threadId ? 1 : 0,
    diagnostics: {},
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
