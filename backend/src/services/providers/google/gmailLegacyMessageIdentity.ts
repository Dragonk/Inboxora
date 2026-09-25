import type { GoogleApiOptions } from './googleApiClient.js';
import {
  fetchGmailMessage,
  fetchGmailMessageIds,
  localMessageForGmailMessage,
} from './gmailMail.js';

export interface GmailIdentityQueryExecutor {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export type GmailIdentityResolution =
  | { kind: 'resolved'; providerMessageId: string; providerThreadId: string | null; source: 'direct' | 'local_sibling' | 'gmail_search' }
  | { kind: 'identity_missing' }
  | { kind: 'ambiguous' };

export interface GmailLegacyMessageIdentityInput {
  messageId: string;
  accountId: string;
  directProviderMessageId?: string | null;
  rfcMessageId?: string | null;
  fromEmail?: string | null;
  subject?: string | null;
  date?: string | number | Date | null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSubject(value: unknown): string | null {
  const subject = clean(value);
  return subject ? subject.replace(/\s+/g, ' ').toLocaleLowerCase() : null;
}

function sameEmail(left: unknown, right: unknown): boolean {
  const a = clean(left)?.toLocaleLowerCase() ?? null;
  const b = clean(right)?.toLocaleLowerCase() ?? null;
  return a === null || b === null ? a === b : a === b;
}

function closeDate(left: string | number | Date | null | undefined, right: string | number | Date | null | undefined): boolean {
  if (!left || !right) return left == null || right == null;
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 5 * 60 * 1000;
}

function gmailSearchQuery(messageId: string): string {
  return `rfc822msgid:${messageId}`;
}

export async function resolveGmailMessageIdentity(
  client: GmailIdentityQueryExecutor,
  api: GoogleApiOptions,
  input: GmailLegacyMessageIdentityInput,
): Promise<GmailIdentityResolution> {
  const direct = clean(input.directProviderMessageId);
  if (direct) {
    const thread = await client.query<{ provider_thread_id: string | null }>(
      'SELECT provider_thread_id FROM messages WHERE id = $1 AND account_id = $2',
      [input.messageId, input.accountId],
    );
    return {
      kind: 'resolved', providerMessageId: direct,
      providerThreadId: clean(thread.rows[0]?.provider_thread_id), source: 'direct',
    };
  }

  const rfcMessageId = clean(input.rfcMessageId);
  if (!rfcMessageId) return { kind: 'identity_missing' };

  const local = await client.query<{ provider_message_id: string; provider_thread_id: string | null }>(
    `SELECT provider_message_id, provider_thread_id
       FROM messages
      WHERE account_id = $1
        AND id <> $2
        AND NULLIF(BTRIM(provider_message_id), '') IS NOT NULL
        AND NULLIF(BTRIM(message_id), '') = $3
        AND ($4::text IS NULL OR lower(from_email) = lower($4))
        AND ($5::timestamptz IS NULL OR date BETWEEN $5::timestamptz - INTERVAL '5 minutes'
                                             AND $5::timestamptz + INTERVAL '5 minutes')
      ORDER BY date DESC NULLS LAST, id
      LIMIT 2`,
    [input.accountId, input.messageId, rfcMessageId, clean(input.fromEmail), input.date ?? null],
  );
  if (local.rows.length === 1) {
    return {
      kind: 'resolved', providerMessageId: local.rows[0]!.provider_message_id,
      providerThreadId: clean(local.rows[0]!.provider_thread_id), source: 'local_sibling',
    };
  }
  if (local.rows.length > 1) return { kind: 'ambiguous' };

  const listed = await fetchGmailMessageIds(api, { q: gmailSearchQuery(rfcMessageId), maxResults: 10, includeSpamTrash: true });
  if (listed.nextPageToken) return { kind: 'ambiguous' };

  const expectedSubject = normalizeSubject(input.subject);
  const candidates: Array<{ providerMessageId: string; providerThreadId: string | null }> = [];
  for (const entry of listed.messages) {
    if (!entry.id) continue;
    const provider = await fetchGmailMessage(api, entry.id, 'metadata');
    if (!provider) continue;
    const localMessage = localMessageForGmailMessage(provider, { accountId: input.accountId, pathByLabelId: new Map() });
    if (!localMessage) continue;
    if (clean(localMessage.messageId) !== rfcMessageId) continue;
    if (clean(input.fromEmail) && !sameEmail(localMessage.fromEmail, input.fromEmail)) continue;
    if (expectedSubject && normalizeSubject(localMessage.subject) !== expectedSubject) continue;
    if (input.date && !closeDate(localMessage.date, input.date)) continue;
    candidates.push({ providerMessageId: localMessage.providerMessageId, providerThreadId: localMessage.providerThreadId });
    if (candidates.length > 1) break;
  }
  if (candidates.length !== 1) return { kind: candidates.length > 1 ? 'ambiguous' : 'identity_missing' };
  return { kind: 'resolved', providerMessageId: candidates[0]!.providerMessageId, providerThreadId: candidates[0]!.providerThreadId, source: 'gmail_search' };
}
