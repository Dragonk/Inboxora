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

export function ownIdentityAddresses(account = {}) {
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const delivery = Array.isArray(account.delivery_addresses) ? account.delivery_addresses : [];
  return [account.email_address, ...aliases.map(alias => alias.email || alias), ...delivery.map(item => item.email || item)].filter(Boolean);
}

export async function resolveOwnIdentityAddresses(db, accountId) {
  const result = await db.query(`SELECT a.email_address, COALESCE(json_agg(json_build_object('email', aa.email)) FILTER (WHERE aa.id IS NOT NULL), '[]'::json) AS aliases
    FROM email_accounts a LEFT JOIN account_aliases aa ON aa.account_id = a.id
   WHERE a.id = $1 GROUP BY a.id`, [accountId]);
  return ownIdentityAddresses(result?.rows?.[0] || {});
}

export function conversationPersistedFields(rawMessage, account) {
  const provider = providerMetadataForMessage(rawMessage, account);
  return {
    conversation_raw_headers: conversationRawHeaders(rawMessage),
    conversation_thread_index: provider.threadIndex,
    conversation_thread_topic: provider.threadTopic,
    provider,
    identities: ownIdentityAddresses(account),
  };
}
