import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { normalizeProviderReferences, parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

function outlookConversationRoot(value) {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
    if (raw.length < 22 || (raw.length - 22) % 5 !== 0) return null;
    return raw.subarray(0, 22).toString('hex');
  } catch { return null; }
}

export interface ProviderConversationMetadata {
  provider?: string | null;
  providerThreadId?: string | null;
  references?: unknown;
  [key: string]: unknown;
}

type HeaderBag = Record<string, unknown> | Map<string, unknown>;

interface ConversationMetadataInput {
  attributes?: Record<string, unknown>;
  parsedHeaders?: HeaderBag;
  headers?: HeaderBag;
  references?: unknown;
  inReplyTo?: unknown;
  [key: string]: unknown;
}

export function providerMetadataForMessage(parsed: ConversationMetadataInput | null | undefined, account: { id?: string; imap_host?: string } | null | undefined): ProviderConversationMetadata {
  const metadata = parseProviderMetadata(parsed, account);
  const attributes = parsed?.attributes || parsed || {};
  const headers = parsed?.parsedHeaders || parsed?.headers || {};
  const header = (name) => {
    if (headers && typeof (headers as Map<string, unknown>).get === 'function') {
      const map = headers as Map<string, unknown>;
      const direct = map.get(name) ?? map.get(name.toLowerCase());
      if (direct != null) return direct;
      for (const [key, value] of map.entries()) {
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
    isStrong: metadata.provider === 'gmail' && metadata.providerThreadId != null,
    source: metadata.providerThreadId ? (metadata.source || 'provider-thread-id') : outlookConversationRoot(threadIndex) ? 'outlook-conversation-index-root' : metadata.source,
    references: normalizeProviderReferences(parsed?.references || []),
    inReplyTo: normalizeMessageIdList(parsed?.inReplyTo).at(-1) || null,
  };
}
