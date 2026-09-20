import { query, withTransaction } from './db.js';
import type { PoolClient } from 'pg';
import { syncGraphMailFoldersForAccount, syncGraphMailMessagesForAccount } from './providers/microsoft/graphMailSync.js';
import { listGmailMailAccounts, syncGmailMailLabelsForAccount, syncGmailMailMessagesForAccount } from './providers/google/gmailMailSync.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import type { FetchLike } from './providerAuthService.js';

/**
 * Creating a **native mail account** for a mailbox the user has already authorized.
 *
 * This is the piece the interface needs to separate two ideas that were previously entangled: *configuring a
 * provider application* (an administrator's job, in Settings → Integrations) and *connecting a mailbox* (the
 * user's, in Settings → Accounts). The OAuth flows already exist and they record a `provider_connection` plus
 * its grant; what was missing is the step that turns an authorized connection into an account, so the only
 * ways to get a native account were to add an IMAP account and then migrate it, or to connect it by hand.
 *
 * Three rules shape it:
 *
 * - **The identity comes from the provider.** The address and the mailbox id are read from the connection the
 *   OAuth flow verified (`provider_user_id`), never from a form field: a typed address could differ from the
 *   mailbox that was actually authorized, and the mailbox is what the account will read and send.
 * - **One account per mailbox.** An existing account for that address is not duplicated — it is reported with
 *   its id and its current transport so the interface can offer the migration that already exists (cutover to
 *   Graph for Microsoft, the Gmail API recommendation for Google) instead of silently creating a second row.
 * - **Ownership is enforced.** The connection must belong to the caller, and it must be an active connection
 *   of the matching provider with a usable grant.
 */

export type NativeProvider = 'microsoft' | 'google';

export interface NativeAccountInput {
  userId: string;
  provider: NativeProvider;
  /** The connection to bind; without one, the caller's only connection of that provider is used. */
  connectionId?: string | null;
  /** The account's display name; defaults to the mailbox address. */
  name?: string | null;
  fetchImpl?: FetchLike;
  /** Run folder/label discovery after creating the row. Default true. */
  discover?: boolean;
}

export interface NativeAccountRow {
  id: string;
  email_address: string | null;
  name: string | null;
  mail_transport: string | null;
  protocol: string | null;
  provider_connection_id: string | null;
  provider_mailbox_id: string | null;
}

export type NativeAccountResult =
  | { status: 'created'; account: NativeAccountRow; connectionId: string; discovered: boolean; folders: number }
  | { status: 'exists_native'; account: NativeAccountRow; connectionId: string }
  | {
      status: 'exists_other_transport';
      code: 'ACCOUNT_EXISTS';
      httpStatus: number;
      message: string;
      existingAccountId: string;
      existingTransport: string;
      /** Which existing action moves that account onto this transport. */
      suggestion: 'migrate_microsoft' | 'migrate_google';
    }
  | { status: 'refused'; code: string; httpStatus: number; message: string }
  | { status: 'not_found' };

/** The transport and protocol a native account of each provider uses. */
export function nativeTransportFor(provider: NativeProvider): { transport: string; protocol: string } {
  return provider === 'microsoft'
    ? { transport: 'microsoft_graph', protocol: 'microsoft_graph' }
    : { transport: 'gmail_api', protocol: 'gmail_api' };
}

interface ConnectionRow {
  id: string;
  provider: string;
  provider_user_id: string | null;
  subject: string | null;
  status: string;
}

/**
 * The connection this account will be bound to.
 *
 * An explicit choice must be the caller's own connection of the right provider. Without one, a connection
 * whose verified address is not enough to identify it — several connections of one provider are normal (a
 * contacts grant and a mail grant), so the caller is asked to name one rather than guessing.
 */
async function resolveConnection(
  client: PoolClient,
  input: NativeAccountInput,
): Promise<ConnectionRow | { refused: { code: string; httpStatus: number; message: string } }> {
  if (input.connectionId) {
    const result = await client.query<ConnectionRow>(
      `SELECT id, provider, provider_user_id, subject, status FROM provider_connections
        WHERE id = $1 AND user_id = $2`,
      [input.connectionId, input.userId],
    );
    const connection = result.rows[0];
    if (!connection) {
      return { refused: { code: 'CONNECTION_NOT_FOUND', httpStatus: 404, message: 'That provider connection does not belong to this user' } };
    }
    if (connection.provider !== input.provider) {
      return { refused: { code: 'CONNECTION_PROVIDER_MISMATCH', httpStatus: 409, message: `That connection is a ${connection.provider} connection, not a ${input.provider} one` } };
    }
    return connection;
  }
  const result = await client.query<ConnectionRow>(
    `SELECT id, provider, provider_user_id, subject, status FROM provider_connections
      WHERE user_id = $1 AND provider = $2 AND status = 'active'
      ORDER BY created_at DESC`,
    [input.userId, input.provider],
  );
  if (!result.rows.length) {
    return {
      refused: {
        code: 'PROVIDER_AUTH_REQUIRED', httpStatus: 409,
        message: input.provider === 'microsoft'
          ? 'No Microsoft authorization exists yet. Sign in with Microsoft first.'
          : 'No Google authorization exists yet. Sign in with Google first.',
      },
    };
  }
  if (result.rows.length > 1) {
    return {
      refused: {
        code: 'CONNECTION_REQUIRED', httpStatus: 409,
        message: 'More than one provider connection matches; name the connection explicitly',
      },
    };
  }
  return result.rows[0]!;
}

/** Create (or find) a native mail account for an authorized mailbox, in place of an IMAP one. */
export async function createNativeMailAccount(input: NativeAccountInput): Promise<NativeAccountResult> {
  if (!providerIntegrationsEnabled()) {
    return { status: 'refused', code: 'PROVIDER_INTEGRATIONS_DISABLED', httpStatus: 403, message: 'Provider integrations are disabled on this installation' };
  }
  const { transport, protocol } = nativeTransportFor(input.provider);

  const outcome = await withTransaction<NativeAccountResult>(async client => {
    const resolved = await resolveConnection(client, input);
    if ('refused' in resolved) return { status: 'refused', ...resolved.refused };
    const connection = resolved;
    if (connection.status !== 'active') {
      return {
        status: 'refused', code: 'PROVIDER_AUTH_REQUIRED', httpStatus: 409,
        message: `The provider connection is ${connection.status}; authorize it again before adding the account`,
      };
    }
    const address = (connection.provider_user_id ?? '').trim();
    if (!address) {
      return {
        status: 'refused', code: 'PROVIDER_IDENTITY_MISSING', httpStatus: 409,
        message: 'That authorization does not report a mailbox address, so no account can be created from it',
      };
    }

    const existing = await client.query<NativeAccountRow>(
      `SELECT id, email_address, name, mail_transport, protocol, provider_connection_id, provider_mailbox_id
         FROM email_accounts
        WHERE user_id = $1 AND lower(email_address) = lower($2)
        ORDER BY created_at ASC`,
      [input.userId, address],
    );
    const current = existing.rows[0];
    if (current) {
      if (current.mail_transport === transport) {
        // A retry after a lost response, or a second dashboard tab: the account already exists and is native.
        return { status: 'exists_native', account: current, connectionId: current.provider_connection_id ?? connection.id };
      }
      // One mailbox, one account: the existing row is not duplicated. The interface turns this into the
      // migration that already exists rather than an error the user cannot act on.
      return {
        status: 'exists_other_transport',
        code: 'ACCOUNT_EXISTS',
        httpStatus: 409,
        message: input.provider === 'microsoft'
          ? `${address} is already added as an IMAP/SMTP account. Migrate it to Microsoft Graph instead of adding it again.`
          : `${address} is already added as an IMAP/SMTP account. Migrate it to the Gmail API instead of adding it again.`,
        existingAccountId: current.id,
        existingTransport: current.mail_transport ?? 'imap_smtp',
        suggestion: input.provider === 'microsoft' ? 'migrate_microsoft' : 'migrate_google',
      };
    }

    const mailboxId = connection.subject ?? connection.provider_user_id ?? address;
    // `imap_port`/`smtp_port` carry column defaults (993/587), so a native account would otherwise claim an
    // IMAP port it never uses; they are set explicitly to NULL with the rest of the connection fields, because
    // "no IMAP/SMTP configuration" has to be true in the row, not only in the interface.
    const created = await client.query<NativeAccountRow>(
      `INSERT INTO email_accounts
         (user_id, name, email_address, protocol, mail_transport, provider_connection_id, provider_mailbox_id,
          mail_method_preference, migration_state, migration_required, enabled,
          imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$5,'active_native',false,true,
               NULL, NULL, NULL, NULL, NULL, NULL)
       RETURNING id, email_address, name, mail_transport, protocol, provider_connection_id, provider_mailbox_id`,
      [input.userId, input.name?.trim() || address, address, protocol, transport, connection.id, mailboxId],
    );
    const account = created.rows[0]!;
    return { status: 'created', account, connectionId: connection.id, discovered: false, folders: 0 };
  });

  if (outcome.status !== 'created' || input.discover === false) return outcome;

  // After the row exists: give the refresh schedule its first collection, exactly as the cutover does. A
  // provider failure here does not un-create the account — the transport is native and the next sync retries.
  try {
    if (input.provider === 'microsoft') {
      const discovery = await syncGraphMailFoldersForAccount({
        userId: input.userId,
        connectionId: outcome.connectionId,
        accountId: outcome.account.id,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      await syncGraphMailMessagesForAccount({
        userId: input.userId,
        connectionId: outcome.connectionId,
        accountId: outcome.account.id,
        config: microsoftConfigFromEnv(),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      return { ...outcome, discovered: true, folders: discovery.folders };
    }
    // Gmail labels are per mailbox; the account was just created, so its id is the only one to discover.
    const discovery = await syncGmailMailLabelsForAccount({
      userId: input.userId,
      connectionId: outcome.connectionId,
      accountId: outcome.account.id,
      config: googleConfigFromEnv(),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    await syncGmailMailMessagesForAccount({
      userId: input.userId,
      connectionId: outcome.connectionId,
      accountId: outcome.account.id,
      config: googleConfigFromEnv(),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { ...outcome, discovered: true, folders: discovery.labels ?? 0 };
  } catch (caught) {
    console.warn(
      `Mail discovery after adding account ${outcome.account.id} failed:`,
      caught instanceof Error ? caught.message : caught,
    );
    return { ...outcome, discovered: false, folders: 0 };
  }
}

/**
 * Whether the caller already has an account for each authorized mailbox, so the interface can offer the right
 * action before it starts an authorization.
 *
 * This is what makes "Add Google" safe for someone who already uses Gmail over IMAP: the address is known the
 * moment the authorization lands, and the answer is "migrate that account" rather than a second mailbox.
 */
export async function describeNativeCandidates(input: { userId: string; provider: NativeProvider }): Promise<Array<{
  address: string;
  connectionId: string;
  existingAccountId: string | null;
  existingTransport: string | null;
}>> {
  const connections = await query<{ id: string; provider_user_id: string | null }>(
    `SELECT id, provider_user_id FROM provider_connections
      WHERE user_id = $1 AND provider = $2 AND status = 'active'
      ORDER BY created_at DESC`,
    [input.userId, input.provider],
  );
  const candidates: Array<{ address: string; connectionId: string; existingAccountId: string | null; existingTransport: string | null }> = [];
  for (const connection of connections.rows) {
    const address = (connection.provider_user_id ?? '').trim();
    if (!address) continue;
    const account = await query<{ id: string; mail_transport: string | null }>(
      'SELECT id, mail_transport FROM email_accounts WHERE user_id = $1 AND lower(email_address) = lower($2) ORDER BY created_at ASC LIMIT 1',
      [input.userId, address],
    );
    candidates.push({
      address,
      connectionId: connection.id,
      existingAccountId: account.rows[0]?.id ?? null,
      existingTransport: account.rows[0]?.mail_transport ?? null,
    });
  }
  return candidates;
}

/** The configured Microsoft client the interface reads, so a card never shows a raw secret. */
export function nativeProviderReadiness(): { microsoft: boolean; google: boolean } {
  return {
    microsoft: Boolean(microsoftConfigFromEnv().clientId && microsoftConfigFromEnv().tenantId),
    google: Boolean(googleConfigFromEnv().clientId && googleConfigFromEnv().clientSecret),
  };
}

/** The Gmail mail accounts of a connection, used by the account list to mark a mailbox as already native. */
export async function nativeMailAccountIds(connectionId: string): Promise<string[]> {
  return withTransaction(client => listGmailMailAccounts(client, { userId: '', connectionId })).catch(() => []);
}
