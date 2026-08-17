import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

export function providerMetadataForMessage(parsed, account) {
  const metadata = parseProviderMetadata(parsed, account);
  const attributes = parsed?.attributes || parsed || {};
  const threadIndex = attributes.threadIndex ?? attributes['thread-index'] ?? null;
  const threadTopic = attributes.threadTopic ?? attributes['thread-topic'] ?? null;
  return {
    ...metadata,
    namespace: providerNamespace({ provider: metadata.provider, accountId: account?.id, host: account?.imap_host }),
    threadIndex: threadIndex == null ? null : String(threadIndex),
    threadTopic: threadTopic == null ? null : String(threadTopic),
    isStrong: metadata.provider === 'gmail' && metadata.providerThreadId != null,
    source: metadata.providerThreadId ? 'provider-thread-id' : threadIndex ? 'thread-index' : metadata.source,
    references: parsed?.references ? metadata.references : [],
    inReplyTo: normalizeMessageIdList(parsed?.inReplyTo).at(-1) || null,
  };
}
