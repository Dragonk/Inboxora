export function parseAddressListField(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

/**
 * Extract a normalized lowercase email from a raw address string, handling
 * "Name <mail@example.com>" and bare "mail@example.com" forms.
 * Mirrors backend `conversationIngestEnvelope.js#normalizeAddress` so the
 * frontend own-identity set matches the server's classification exactly.
 */
function normalizeAddress(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase().trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase().trim();
  return null;
}

/**
 * P1-16: Central own-identity resolver for Reply All self-exclusion.
 *
 * Returns a Set of lowercase own addresses for the account + message pair,
 * comprising:
 *   - the account's primary email_address,
 *   - account aliases / send-as addresses,
 *   - the message's persisted `delivery_addresses` column, which already
 *     aggregates Delivered-To / X-Delivered-To / X-Original-To / Envelope-To
 *     headers parsed at ingest (see backend `parseDeliveryAddresses` and
 *     `conversationIngestEnvelope.resolveOwnIdentityAddresses`).
 *
 * This MUST stay in sync with the backend `resolveOwnIdentityAddresses` set so
 * that direction classification and Reply All self-exclusion agree on what is
 * "me". Without the delivery addresses, a catch-all / shared alias such as
 * `user+newsletter@example.com` would not be recognized as own and Reply All
 * would Cc the user's own copy back to themselves.
 */
export function collectOwnAddresses({ account, message } = {}) {
  const own = new Set();
  const push = value => {
    const email = normalizeAddress(value);
    if (email) own.add(email);
  };

  if (account) {
    push(account.email_address);
    const aliases = Array.isArray(account.aliases) ? account.aliases : [];
    for (const alias of aliases) push(alias?.email ?? alias);
  }

  if (message) {
    const raw = message.delivery_addresses;
    const list = Array.isArray(raw)
      ? raw
      : (typeof raw === 'string'
          ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
          : []);
    for (const item of list) push(typeof item === 'string' ? item : item?.email ?? item?.address);
  }

  return own;
}

export function pickReplyAlias({ aliases, deliveryAddresses, toAddresses, ccAddresses, fromEmail }) {
  if (!aliases || !aliases.length) return null;

  const delivered = parseAddressListField(deliveryAddresses).map(e => (e || '').toLowerCase()).filter(Boolean);
  const to = parseAddressListField(toAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const cc = parseAddressListField(ccAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const from = (fromEmail || '').toLowerCase();

  const deliveredMatch = aliases.find(al => delivered.includes(al.email.toLowerCase()));
  if (deliveredMatch) return deliveredMatch.id;

  // Same scan as before delivery addresses existed: aliases in creation order
  // against the combined To/Cc/From set, so multi-alias picks don't change.
  const headerEmails = [...to, ...cc];
  const match = aliases.find(al => {
    const aliasEmail = al.email.toLowerCase();
    return headerEmails.includes(aliasEmail) || (from && from === aliasEmail);
  });
  return match ? match.id : null;
}
