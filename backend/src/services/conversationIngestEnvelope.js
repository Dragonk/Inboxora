import { providerMetadataForMessage } from './providerConversationMetadata.js';

export function conversationRawHeaders(rawMessage) {
  if (!rawMessage?.headers) return null;
  if (typeof rawMessage.headers === 'string') return rawMessage.headers;
  if (typeof rawMessage.headers.entries === 'function') {
    return [...rawMessage.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\r\n');
  }
  if (typeof rawMessage.headers === 'object') {
    return Object.entries(rawMessage.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  }
  return null;
}

export function conversationPersistedFields(rawMessage, account) {
  const provider = providerMetadataForMessage(rawMessage, account);
  return {
    conversation_raw_headers: conversationRawHeaders(rawMessage),
    conversation_thread_index: provider.threadIndex,
    conversation_thread_topic: provider.threadTopic,
    provider,
    identities: [account?.email_address].filter(Boolean),
  };
}
