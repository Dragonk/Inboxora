import { createHash } from 'crypto';

function toScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const scalar = typeof value === 'bigint' ? String(value) : String(value);
  return scalar === '' || scalar.toUpperCase() === 'NIL' ? null : scalar;
}

/** The manager account fields the provider helpers read. */
export interface ProviderAccount {
  id?: string | null;
  imap_host?: string | null;
  capabilities?: unknown;
  imap_capabilities?: unknown;
}

/** A fetched message (or a bare attributes bag) as provider metadata reads it. */
export interface ProviderMessage {
  attributes?: Record<string, unknown> | null;
  provider_message_id?: unknown;
  provider_thread_id?: unknown;
  [key: string]: unknown;
}

export interface ProviderNamespaceInput {
  provider?: string | null;
  accountId?: string | null;
  host?: string | null;
}

/** An IMAP capability bag: ImapFlow exposes a Map, which spreads to [name, enabled] pairs. */
export type ProviderCapabilityEntry = [string, boolean | number];

export interface ProviderCapabilityClient {
  capabilities?: Iterable<ProviderCapabilityEntry> | null;
}

export function providerNamespace({ provider, accountId, host }: ProviderNamespaceInput) {
  return [provider || 'generic', accountId || 'unknown-account', host || 'unknown-host'].join(':');
}

export function classifyProviderHost(host: string | null | undefined = '') {
  const value = String(host).toLowerCase();
  if (/gmail|googlemail/.test(value)) return 'gmail';
  if (/outlook|office365|microsoft|exchange|hotmail|live\.com/.test(value)) return 'outlook';
  return 'generic';
}

export function parseProviderMetadata(msg: ProviderMessage | null | undefined, account: ProviderAccount | null | undefined) {
  const attributes: Record<string, unknown> = msg?.attributes || msg || {};
  const host = String(account?.imap_host || '').toLowerCase();
  const provider = classifyProviderHost(host);
  // ImapFlow intentionally normalizes OBJECTID and X-GM-MSGID into `emailId`.
  // Keep that value provider-neutral; only the legacy xGm* aliases are explicitly
  // identified as Gmail extensions. This prevents OBJECTID from being mislabeled
  // as X-GM-MSGID while retaining compatibility with older fixtures.
  const msgId = attributes.emailId ?? attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid ?? msg?.provider_message_id ?? null;
  const threadId = attributes.threadId ?? attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid ?? msg?.provider_thread_id ?? null;
  const safeMsgId = toScalar(msgId);
  const safeThreadId = toScalar(threadId);
  const legacyGmailMsgId = attributes.xGmMsgId ?? attributes['x-gm-msgid'] ?? attributes.x_gm_msgid;
  const legacyGmailThreadId = attributes.xGmThrid ?? attributes['x-gm-thrid'] ?? attributes.x_gm_thrid;
  return {
    provider,
    accountId: account?.id || null,
    providerMessageId: safeMsgId,
    providerThreadId: safeThreadId,
    namespace: providerNamespace({ provider, accountId: account?.id, host: account?.imap_host }),
    source: safeThreadId ? (legacyGmailThreadId != null ? 'x-gm-thread' : 'provider-thread-id') : safeMsgId ? (legacyGmailMsgId != null ? 'x-gm-message' : 'provider-email-id') : null,
    isStrong: provider === 'gmail' && safeThreadId !== null,
    confidence: safeThreadId ? 1 : safeMsgId ? 0.8 : 0,
    diagnostics: {
      fingerprint: createHash('sha256').update([provider, safeMsgId || '', safeThreadId || ''].join('|')).digest('hex'),
      messageIdSource: legacyGmailMsgId != null ? 'x-gm-msgid-alias' : attributes.emailId != null ? 'imapflow-email-id' : null,
      threadIdSource: legacyGmailThreadId != null ? 'x-gm-thrid-alias' : attributes.threadId != null ? 'imapflow-thread-id' : null,
    },
  };
}

export interface ImapFetchQuery {
  uid?: boolean;
  flags?: boolean;
  envelope?: boolean;
  bodyStructure?: boolean;
  headers?: boolean;
  threadId?: boolean;
  bodyParts?: string[];
  [key: string]: unknown;
}

export function providerFetchQuery(account: ProviderAccount | null | undefined, base: ImapFetchQuery = {}, liveCapabilities: ProviderCapabilityEntry[] | string | null = null): ImapFetchQuery {
  const host = (account?.imap_host || '').toLowerCase();
  const provider = classifyProviderHost(host);
  const caps = liveCapabilities || account?.capabilities || account?.imap_capabilities || [];
  const capabilityText = Array.isArray(caps) ? caps.join(' ').toUpperCase() : String(caps).toUpperCase();
  const supportsThreadId = provider === 'gmail' || /(?:OBJECTID|THREADID|X-GM-EXT-1)/.test(capabilityText);
  return supportsThreadId ? { ...base, headers: true, threadId: true } : { ...base };
}

export function providerCapabilitiesFromClient(client: ProviderCapabilityClient | null | undefined): ProviderCapabilityEntry[] {
  return client?.capabilities ? [...client.capabilities] : [];
}

export function normalizeProviderReferences(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return [...new Set([...text.matchAll(/<[^<>\r\n]+>/g)].map(m => m[0]))];
}
