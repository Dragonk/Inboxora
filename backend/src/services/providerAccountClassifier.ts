import { query } from './db.js';
import type { PoolClient } from 'pg';

/**
 * Which provider a **legacy** mail account belongs to.
 *
 * The same question used to be answered in several places with different rules: the Google recommendation
 * recognised a Gmail mailbox by its IMAP host, while the Gmail cutover accepted only
 * `oauth_provider = 'google'`. A real 4.0.4 account — added over IMAP with an app password — has
 * `oauth_provider = NULL` and a Gmail host, so the interface offered a migration the cutover then refused as
 * "not applicable". This module is the single answer to that question.
 *
 * Two properties make it safe to use everywhere:
 *
 * - **It only classifies.** A classification says "this legacy account may be a candidate for the provider's
 *   native transport"; it never authorises a switch. The cutover still requires an active provider connection
 *   of that provider, owned by the user, whose verified identity matches the account's address, with the
 *   scopes the transport needs. A host name alone can never move a mailbox.
 * - **It uses signals a 4.0.4 database actually has.** The stored `oauth_provider`, the IMAP host of the
 *   presets Inboxora shipped, and — for a Workspace mailbox on a custom domain, where no host or domain can
 *   tell — an existing active provider connection whose `provider_user_id` is this account's address.
 */

export type ProviderAccountKind = 'google' | 'microsoft';

/** The IMAP hosts Inboxora's own presets used for each provider. */
const MICROSOFT_IMAP_HOSTS = new Set([
  'outlook.office365.com',
  'imap-mail.outlook.com',
  'outlook.office.com',
  'imap.outlook.com',
]);

/** Whether an IMAP host belongs to Gmail. The domain of the *address* proves nothing (Workspace). */
export function isGmailImapHost(host: string | null | undefined): boolean {
  const value = (host ?? '').trim().toLowerCase();
  if (!value) return false;
  return value === 'imap.gmail.com'
    || value === 'imap.googlemail.com'
    || value.endsWith('.gmail.com')
    || value.endsWith('.googlemail.com');
}

/** Whether an IMAP host is one of the Microsoft hosts the presets used. */
export function isMicrosoftImapHost(host: string | null | undefined): boolean {
  const value = (host ?? '').trim().toLowerCase();
  return value ? MICROSOFT_IMAP_HOSTS.has(value) : false;
}

export interface ClassifiableAccount {
  email_address?: string | null;
  imap_host?: string | null;
  oauth_provider?: string | null;
  /** Optional: an already loaded list of the user's active provider connections. */
  connections?: Array<{ provider: string; provider_user_id: string | null }>;
}

/** The connection signals an account is matched against, when the caller has them. */
function connectionMatches(account: ClassifiableAccount, kind: ProviderAccountKind): boolean {
  const address = (account.email_address ?? '').trim().toLowerCase();
  if (!address || !account.connections?.length) return false;
  return account.connections.some(connection =>
    connection.provider === kind
    && (connection.provider_user_id ?? '').trim().toLowerCase() === address);
}

/**
 * Classify one account, from the row alone.
 *
 * `connections` is optional on purpose: the host and `oauth_provider` signals are enough for a mailbox that
 * was set up from Inboxora's own presets, and a caller that has the connections can pass them to also
 * recognise a custom-domain Workspace mailbox.
 */
export function classifyProviderAccount(account: ClassifiableAccount): ProviderAccountKind | null {
  const oauthProvider = (account.oauth_provider ?? '').trim().toLowerCase();
  if (oauthProvider === 'google') return 'google';
  if (oauthProvider === 'microsoft') return 'microsoft';

  const gmail = isGmailImapHost(account.imap_host);
  const microsoft = isMicrosoftImapHost(account.imap_host);
  // A host that belongs to one provider and a stored OAuth provider that says the other is a contradiction the
  // row itself has to resolve; prefer the explicit value and otherwise refuse to guess by returning nothing
  // when both signals fire.
  if (gmail && microsoft) return null;
  if (gmail) return 'google';
  if (microsoft) return 'microsoft';

  // No host signal: only a verified connection identity can classify the mailbox (a Workspace domain, or a
  // Microsoft tenant host we do not know).
  if (connectionMatches(account, 'google')) return 'google';
  if (connectionMatches(account, 'microsoft')) return 'microsoft';
  return null;
}

/** The active provider connections of a user, in the shape the classifier reads. */
export async function providerConnectionSignals(
  userId: string,
  client?: PoolClient,
): Promise<Array<{ provider: string; provider_user_id: string | null }>> {
  const sql = `SELECT provider, provider_user_id FROM provider_connections
                WHERE user_id = $1 AND status = 'active'`;
  const result = client
    ? await client.query<{ provider: string; provider_user_id: string | null }>(sql, [userId])
    : await query<{ provider: string; provider_user_id: string | null }>(sql, [userId]);
  return result.rows;
}

/**
 * Classify an account by id, for a caller that only has the id (a route, or the maintenance paths).
 *
 * Loads the account and the user's connections in one place, so no caller has to remember which signals to
 * gather — which is how the notice and the cutover drifted apart in the first place.
 */
export async function classifyProviderAccountById(input: {
  userId: string;
  accountId: string;
  client?: PoolClient;
}): Promise<{ kind: ProviderAccountKind | null; account: ClassifiableAccount | null }> {
  const sql = `SELECT email_address, imap_host, oauth_provider FROM email_accounts
                WHERE id = $1 AND user_id = $2`;
  const result = input.client
    ? await input.client.query<ClassifiableAccount>(sql, [input.accountId, input.userId])
    : await query<ClassifiableAccount>(sql, [input.accountId, input.userId]);
  const account = result.rows[0] ?? null;
  if (!account) return { kind: null, account: null };
  const connections = await providerConnectionSignals(input.userId, input.client);
  return { kind: classifyProviderAccount({ ...account, connections }), account };
}
