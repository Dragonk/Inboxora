import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

function outlookConversationRoot(value) {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
    if (raw.length < 22 || (raw.length - 22) % 5 !== 0) return null;
    return raw.subarray(0, 22).toString('hex');
  } catch { return null; }
}

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
    providerThreadId: metadata.providerThreadId || (metadata.provider === 'outlook' ? outlookConversationRoot(threadIndex) : null),
    isStrong: metadata.providerThreadId != null || (metadata.provider === 'outlook' && Boolean(outlookConversationRoot(threadIndex))),
    source: metadata.providerThreadId ? (metadata.source || 'provider-thread-id') : outlookConversationRoot(threadIndex) ? 'outlook-conversation-index-root' : metadata.source,
    references: parsed?.references ? metadata.references : [],
    inReplyTo: normalizeMessageIdList(parsed?.inReplyTo).at(-1) || null,
  };
}
