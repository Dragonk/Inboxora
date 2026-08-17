import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

export function providerMetadataForMessage(parsed, account) {
  const metadata = parseProviderMetadata(parsed, account);
  const attributes = parsed?.attributes || parsed || {};
  const headers = parsed?.parsedHeaders || parsed?.headers || {};
  const header = (name) => {
    if (headers && typeof headers.get === 'function') {
      const direct = headers.get(name) ?? headers.get(name.toLowerCase());
      if (direct != null) return direct;
      for (const [key, value] of headers.entries()) {
        if (String(key).toLowerCase() === name.toLowerCase()) return value;
      }
      return null;
    }
    const key = Object.keys(headers || {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const threadIndex = attributes.threadIndex ?? attributes['thread-index'] ?? header('thread-index');
  const threadTopic = attributes.threadTopic ?? attributes['thread-topic'] ?? header('thread-topic');
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
