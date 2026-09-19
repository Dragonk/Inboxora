import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { normalizeProviderReferences, parseProviderMetadata, providerNamespace } from './providerThreadAdapter.js';

function outlookConversationRoot(value: unknown): string | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
    if (raw.length < 22 || (raw.length - 22) % 5 !== 0) return null;
    return raw.subarray(0, 22).toString('hex');
  } catch {
    return null;
  }
}

export interface ProviderConversationMetadata {
  provider?: string | null;
  providerThreadId?: string | null;
  references?: unknown;
  [key: string]: unknown;
}

type HeaderBag = Record<string, unknown> | Map<unknown, unknown>;

interface ConversationMetadataInput {
  attributes?: Record<string, unknown> | null;
  parsedHeaders?: HeaderBag | null;
  headers?: HeaderBag | null;
  references?: unknown;
  inReplyTo?: unknown;
  [key: string]: unknown;
}

function firstPresent(first: unknown, second: unknown, third: unknown): unknown {
  if (first !== null && first !== undefined) return first;
  if (second !== null && second !== undefined) return second;
  return third;
}

function headerValue(headers: HeaderBag | null, name: string): unknown {
  if (headers === null) return null;

  if (headers instanceof Map) {
    const lowerCaseName = name.toLowerCase();
    let direct = headers.get(name);
    if (direct === undefined || direct === null) direct = headers.get(lowerCaseName);
    if (direct !== undefined && direct !== null) return direct;
    for (const [key, value] of headers.entries()) {
      if (typeof key === 'string' && key.toLowerCase() === lowerCaseName) return value;
    }
    return null;
  }

  const lowerCaseName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerCaseName) return headers[key];
  }
  return null;
}

function messageAttributes(parsed: ConversationMetadataInput | null | undefined): Record<string, unknown> {
  if (parsed === null || parsed === undefined) return {};
  if (parsed.attributes !== null && parsed.attributes !== undefined) return parsed.attributes;
  return parsed;
}

function messageHeaders(parsed: ConversationMetadataInput | null | undefined): HeaderBag | null {
  if (parsed === null || parsed === undefined) return null;
  if (parsed.parsedHeaders !== null && parsed.parsedHeaders !== undefined) return parsed.parsedHeaders;
  if (parsed.headers !== null && parsed.headers !== undefined) return parsed.headers;
  return null;
}

export function providerMetadataForMessage(parsed: ConversationMetadataInput | null | undefined, account: { id?: string; imap_host?: string; mail_transport?: string | null } | null | undefined): ProviderConversationMetadata {
  const metadata = parseProviderMetadata(parsed, account);
  const attributes = messageAttributes(parsed);
  const headers = messageHeaders(parsed);
  const threadIndex = firstPresent(attributes.threadIndex, attributes['thread-index'], headerValue(headers, 'thread-index'));
  const threadTopic = firstPresent(attributes.threadTopic, attributes['thread-topic'], headerValue(headers, 'thread-topic'));
  const accountId = account === null || account === undefined ? undefined : account.id;
  const host = account === null || account === undefined ? undefined : account.imap_host;
  // A native Microsoft account is its own provider. Graph's `conversationId` is
  // server-assigned and immutable — the same property that makes Gmail's X-GM-THRID
  // strong evidence — and the message sync stores it as `thread_id`. It must **not** go
  // through the Outlook Thread-Index path below: that expects a 22-byte hex root and
  // returns null for a base64 conversation id, which would silently drop the thread key
  // rather than mis-group it.
  const rawGraphThread = account?.mail_transport === 'microsoft_graph'
    ? (parsed as { thread_id?: unknown } | null | undefined)?.thread_id
    : null;
  const graphThreadId = typeof rawGraphThread === 'string' && rawGraphThread.trim() !== '' ? rawGraphThread.trim() : null;
  const conversationRoot = metadata.providerThreadId === null ? outlookConversationRoot(threadIndex) : null;
  const references = parsed === null || parsed === undefined ? undefined : parsed.references;
  const inReplyTo = parsed === null || parsed === undefined ? undefined : parsed.inReplyTo;

  const normalizedInReplyTo = normalizeMessageIdList(inReplyTo);
  const latestInReplyTo = normalizedInReplyTo.length === 0 ? null : normalizedInReplyTo[normalizedInReplyTo.length - 1];

  return {
    ...metadata,
    ...(graphThreadId === null ? {} : { provider: 'graph' as const }),
    namespace: providerNamespace({ provider: graphThreadId === null ? metadata.provider : 'graph', accountId, host }),
    threadIndex: threadIndex === null || threadIndex === undefined ? null : String(threadIndex),
    threadTopic: threadTopic === null || threadTopic === undefined ? null : String(threadTopic),
    providerThreadId: graphThreadId ?? (metadata.providerThreadId === null && metadata.provider === 'outlook' ? conversationRoot : metadata.providerThreadId),
    isStrong: graphThreadId !== null || (metadata.provider === 'gmail' && metadata.providerThreadId !== null),
    source: graphThreadId !== null
      ? 'provider-thread-id'
      : metadata.providerThreadId !== null
        ? (metadata.source === null ? 'provider-thread-id' : metadata.source)
        : (conversationRoot === null ? metadata.source : 'outlook-conversation-index-root'),
    references: normalizeProviderReferences(references),
    inReplyTo: latestInReplyTo,
  };
}
