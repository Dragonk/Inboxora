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

/**
 * Extract a normalized lowercase email address from a raw address string,
 * handling "Name <mail@example.com>" and bare "mail@example.com" forms.
 * Returns null if no valid email is found.
 */
function normalizeAddress(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase().trim();
  // Bare address — only accept if it looks like an email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase().trim();
  return null;
}

export async function resolveOwnIdentityAddresses(db, accountId, message = null) {
  // Direction is a user-level property. A message sent from managed account B and
  // observed in account A must still be classified as outgoing. Resolve every managed
  // address/alias owned by the account's user, not only aliases of the current account.
  const result = await db.query(`
    SELECT owner.user_id,
           COALESCE(json_agg(DISTINCT jsonb_build_object('email', owned.email_address))
             FILTER (WHERE owned.email_address IS NOT NULL), '[]'::json) AS identities
      FROM email_accounts owner
      JOIN email_accounts owned ON owned.user_id = owner.user_id
     WHERE owner.id = $1
     GROUP BY owner.user_id
  `, [accountId]);
  const owned = result?.rows?.[0] || {};
  const identities = (Array.isArray(owned.identities) ? owned.identities : [])
    .map(item => item?.email || item)
    .filter(Boolean);
  const aliases = await db.query(`
    SELECT aa.email
      FROM email_accounts owner
      JOIN email_accounts managed ON managed.user_id = owner.user_id
      JOIN account_aliases aa ON aa.account_id = managed.id
     WHERE owner.id = $1
  `, [accountId]);
  identities.push(...(aliases?.rows || []).map(row => row.email).filter(Boolean));

  if (message?.delivery_addresses) {
    const delivery = Array.isArray(message.delivery_addresses)
      ? message.delivery_addresses
      : (typeof message.delivery_addresses === 'string'
          ? (() => { try { return JSON.parse(message.delivery_addresses); } catch { return []; } })()
          : []);
    for (const item of delivery) {
      const email = typeof item === 'string' ? normalizeAddress(item) : normalizeAddress(item?.email || item?.address);
      if (email) identities.push(email);
    }
  }

  const deliveryHeaders = [message?.parsedHeaders, message?.headers].filter(Boolean);
  const headerValue = (name) => {
    for (const headers of deliveryHeaders) {
      if (typeof headers.get === 'function') {
        const direct = headers.get(name) ?? headers.get(name.toLowerCase());
        if (direct != null) return direct;
        for (const [key, value] of headers.entries()) {
          if (String(key).toLowerCase() === name) return value;
        }
      } else if (typeof headers === 'object') {
        const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
        if (key) return headers[key];
      }
    }
    return null;
  };
  for (const key of ['delivered-to', 'x-original-to', 'envelope-to']) {
    const value = headerValue(key);
    if (value) {
      for (const part of String(value).split(',')) {
        const email = normalizeAddress(part);
        if (email) identities.push(email);
      }
    }
  }
  return [...new Set(identities.map(String).map(value => value.toLowerCase().trim()).filter(Boolean))];
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
