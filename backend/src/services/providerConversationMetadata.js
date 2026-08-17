import { createHash } from 'crypto';
import { normalizeProviderReferences } from './providerThreadAdapter.js';
import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

export function providerMetadataForMessage(parsed, account) {
  const attributes = parsed?.attributes || parsed || {};
  const host = String(account?.imap_host || '').toLowerCase();
  const provider = host.includes('gmail') ? 'gmail' : host.includes('outlook') || host.includes('office365') || host.includes('microsoft') ? 'outlook' : 'generic';
  const providerMessageId = attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid ?? null;
  const providerThreadId = attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid ?? null;
  const threadIndex = attributes.threadIndex ?? attributes['thread-index'] ?? null;
  const threadTopic = attributes.threadTopic ?? attributes['thread-topic'] ?? null;
  return {
    provider,
    providerMessageId: providerMessageId == null ? null : String(providerMessageId),
    providerThreadId: providerThreadId == null ? null : String(providerThreadId),
    threadIndex: threadIndex == null ? null : String(threadIndex),
    threadTopic: threadTopic == null ? null : String(threadTopic),
    isStrong: provider === 'gmail' && providerThreadId != null,
    source: providerThreadId != null ? 'provider-thread-id' : threadIndex ? 'thread-index' : null,
    references: normalizeProviderReferences(parsed?.references),
    inReplyTo: normalizeMessageIdList(parsed?.inReplyTo).at(-1) || null,
    diagnostics: { fingerprint: createHash('sha256').update(JSON.stringify([provider, String(providerMessageId ?? ''), String(providerThreadId ?? ''), String(threadIndex ?? ''), String(threadTopic ?? '')])).digest('hex') },
  };
}
