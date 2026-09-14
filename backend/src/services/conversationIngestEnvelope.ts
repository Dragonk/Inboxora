import { providerMetadataForMessage } from './providerConversationMetadata.js';

/** A message envelope whose headers may be a raw string, a plain object, or a Map-like bag. */
interface RawHeadersInput {
  headers?: unknown;
}

type HeaderMapLike = { get(name: string): unknown; entries(): Iterable<[unknown, unknown]> };
type HeaderEntriesProvider = { entries(): Iterable<[unknown, unknown]> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Matches the original `typeof headers.get === 'function'` guard: an object can pass
// this without owning `entries`, exactly as the previous code assumed.
function isHeaderMapLike(value: unknown): value is HeaderMapLike {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && 'get' in value
    && typeof value.get === 'function';
}

// Matches the original `typeof rawMessage.headers.entries === 'function'` guard.
function isHeaderEntriesProvider(value: unknown): value is HeaderEntriesProvider {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && 'entries' in value
    && typeof value.entries === 'function';
}

export function conversationRawHeaders(rawMessage: RawHeadersInput | null | undefined) {
  const headers = rawMessage?.headers;
  if (!headers) return null;
  if (typeof headers === 'string') return headers;
  if (isHeaderEntriesProvider(headers)) {
    return [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\r\n');
  }
  if (isRecord(headers)) {
    return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  }
  return null;
}

type IdentityAddress = string | { email?: string | null };

interface OwnIdentityAccount {
  email_address?: string | null;
  aliases?: IdentityAddress[] | null;
  delivery_addresses?: IdentityAddress[] | null;
}

const addressOf = (entry: IdentityAddress): string | null | undefined => (typeof entry === 'string' ? entry : entry?.email);

// Mirrors the historical `item?.email || item` alias extraction: a string alias is
// itself, an object alias falls back to the object when `email` is absent/empty.
const aliasAddress = (entry: IdentityAddress): IdentityAddress | null | undefined =>
  (typeof entry === 'string' ? entry : (entry?.email || entry));

export function ownIdentityAddresses(account: OwnIdentityAccount = {}): string[] {
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const delivery = Array.isArray(account.delivery_addresses) ? account.delivery_addresses : [];
  return [account.email_address, ...aliases.map(addressOf), ...delivery.map(addressOf)].filter((value): value is string => Boolean(value));
}

/**
 * Extract a normalized lowercase email address from a raw address string,
 * handling "Name <mail@example.com>" and bare "mail@example.com" forms.
 * Returns null if no valid email is found.
 */
function normalizeAddress(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase().trim();
  // Bare address — only accept if it looks like an email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase().trim();
  return null;
}

/** The account columns resolveOwnIdentityAddresses reads from email_accounts/account_aliases. */
interface OwnIdentityRow {
  user_id?: string;
  email_address?: string | null;
  aliases?: IdentityAddress[] | null;
}

/** The DB slice resolveOwnIdentityAddresses uses: one account/alias lookup returning OwnIdentityRow. */
interface OwnIdentityLookup {
  query(text: string, params?: unknown[]): Promise<{ rows: OwnIdentityRow[] }>;
}

/** A message row/envelope from which delivery identities are derived. */
interface IngestMessageInput {
  delivery_addresses?: unknown;
  parsedHeaders?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

export async function resolveOwnIdentityAddresses(db: OwnIdentityLookup, accountId: string, message: IngestMessageInput | null = null) {
  // Direction is account-local. Another managed account owned by the same user is
  // an external correspondent from this account's perspective.
  const result = await db.query(`
    SELECT a.user_id, a.email_address,
           COALESCE(json_agg(DISTINCT jsonb_build_object('email', aa.email))
             FILTER (WHERE aa.email IS NOT NULL), '[]'::json) AS aliases
      FROM email_accounts a
      LEFT JOIN account_aliases aa ON aa.account_id = a.id
     WHERE a.id = $1
     GROUP BY a.user_id, a.email_address
  `, [accountId]);
  const account: OwnIdentityRow = result?.rows?.[0] || {};
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const identities = [account.email_address, ...aliases.map(aliasAddress)].filter(Boolean);

  // Delivery headers identify aliases/catch-all addresses that delivered this copy
  // to the current account; they do not import identities from other managed accounts.
  if (message?.delivery_addresses) {
    const delivery: Iterable<unknown> = Array.isArray(message.delivery_addresses)
      ? message.delivery_addresses
      : (typeof message.delivery_addresses === 'string'
          ? (() => { try { return JSON.parse(message.delivery_addresses); } catch { return []; } })()
          : []);
    for (const item of delivery) {
      const email = typeof item === 'string'
        ? normalizeAddress(item)
        : normalizeAddress(isRecord(item) ? (item.email || item.address) : undefined);
      if (email) identities.push(email);
    }
  }

  const deliveryHeaders = [message?.parsedHeaders, message?.headers].filter(Boolean);
  const headerValue = (name: string): unknown => {
    for (const headers of deliveryHeaders) {
      if (isHeaderMapLike(headers)) {
        const direct = headers.get(name) ?? headers.get(name.toLowerCase());
        if (direct != null) return direct;
        for (const [key, value] of headers.entries()) if (String(key).toLowerCase() === name) return value;
      } else if (isRecord(headers)) {
        const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
        if (key) return headers[key];
      }
    }
    return null;
  };
  for (const key of ['delivered-to', 'x-original-to', 'envelope-to']) {
    const value = headerValue(key);
    if (value) for (const part of String(value).split(',')) {
      const email = normalizeAddress(part);
      if (email) identities.push(email);
    }
  }
  return [...new Set(identities.map(String).map(value => value.toLowerCase().trim()).filter(Boolean))];
}

type ConversationMessageInput = Parameters<typeof providerMetadataForMessage>[0];
type ConversationAccount = NonNullable<Parameters<typeof providerMetadataForMessage>[1]> & OwnIdentityAccount;

export function conversationPersistedFields(rawMessage: ConversationMessageInput, account: ConversationAccount) {
  const provider = providerMetadataForMessage(rawMessage, account);
  return {
    conversation_raw_headers: conversationRawHeaders(rawMessage),
    conversation_thread_index: provider.threadIndex,
    conversation_thread_topic: provider.threadTopic,
    provider,
    identities: ownIdentityAddresses(account),
  };
}
