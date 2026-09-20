import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import { classifyProviderAccount, providerConnectionSignals } from './providerAccountClassifier.js';
import { GOOGLE_GRANT_AUDIENCE, googleConfigFromEnv, isGoogleConfigured } from './providerAuthService.js';
import type { FetchLike } from './providerAuthService.js';
import { syncGmailMailLabelsForAccount } from './providers/google/gmailMailSync.js';
import type { GoogleConfig } from './providerAuthService.js';

/**
 * P12 — the in-place Gmail API mail cutover, the Google half of the same guarantee the Microsoft cutover
 * gives.
 *
 * An account reading Google mail over IMAP/SMTP with an app password moves to the Gmail API transport
 * **without changing its identity**: the same `email_accounts.id`, the same messages, folders, drafts,
 * conversations, aliases, signatures, rules and preferences, and no second account for the same mailbox.
 *
 * The three rules that shape the Microsoft module apply here unchanged.
 *
 * **The switch is deliberate and verifiable.** It happens only when the account resolves to an active Google
 * provider connection whose grant actually carries the scope the native paths need (`gmail.modify`, which
 * covers messages, labels, drafts and send — the Calendar/People grants are separate authorizations and do
 * not imply it). A caller may name the connection explicitly; otherwise the connection whose verified
 * identity is this mailbox is resolved, and an ambiguous match is refused rather than guessed.
 *
 * **The switch is atomic and idempotent.** Transport, connection, `migration_state` and the cleared error
 * code are written in **one** UPDATE inside one transaction guarded by `SELECT … FOR UPDATE`. There is no
 * persisted intermediate state, because a durable half-switched row is the state this package forbids. A
 * second call on an already-native account is a no-op.
 *
 * **Google stays optional.** A refusal is recorded as `authorization_required` or
 * `admin_configuration_required` with the reason in `migration_error_code`, and that write never touches the
 * transport or the connection: the IMAP/SMTP path keeps working exactly as before, whether the user has not
 * authorized the API yet, has not been offered it, or simply prefers the app password.
 */

export type GoogleMailMigrationState =
  | 'not_applicable' | 'available' | 'classified' | 'authorization_required'
  | 'admin_configuration_required' | 'authorized' | 'active_native' | 'failed_retryable' | 'needs_review';

const MIGRATION_STATES: readonly GoogleMailMigrationState[] = [
  'not_applicable', 'available', 'classified', 'authorization_required',
  'admin_configuration_required', 'authorized', 'active_native', 'failed_retryable', 'needs_review',
];

export interface GoogleMailMigrationTransition {
  from: GoogleMailMigrationState;
  to: GoogleMailMigrationState;
}

export type GoogleMailCutoverRefusalCode =
  | 'ACCOUNT_MIGRATION_NOT_APPLICABLE'
  | 'PROVIDER_INTEGRATIONS_DISABLED'
  | 'GOOGLE_NOT_CONFIGURED'
  | 'ACCOUNT_MIGRATION_CONNECTION_INVALID'
  | 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED'
  | 'ACCOUNT_MIGRATION_IDENTITY_MISMATCH'
  | 'PROVIDER_AUTH_REQUIRED';

export interface GoogleMailCutoverAccount {
  id: string;
  email_address: string | null;
  mail_transport: string | null;
  protocol: string | null;
  provider_connection_id: string | null;
  provider_mailbox_id: string | null;
  migration_state: GoogleMailMigrationState;
  migration_required: boolean;
  mail_method_preference: string | null;
  transport_generation: number;
}

export type GoogleMailCutoverResult =
  | { status: 'not_found' }
  | { status: 'not_applicable'; reason: string }
  | {
      status: 'refused';
      httpStatus: number;
      code: GoogleMailCutoverRefusalCode;
      message: string;
      missingScopes?: string[];
      migrationState: GoogleMailMigrationState | null;
      recorded: boolean;
    }
  | { status: 'already_native'; account: GoogleMailCutoverAccount; connectionId: string; transitions: GoogleMailMigrationTransition[] }
  | {
      status: 'migrated';
      account: GoogleMailCutoverAccount;
      connectionId: string;
      transitions: GoogleMailMigrationTransition[];
      labelsDiscovered: boolean;
      labels: number;
    };

export interface CutOverGoogleMailInput {
  userId: string;
  accountId: string;
  /** The connection the caller chose; without one the mailbox's own connection is resolved. */
  connectionId?: string | null;
  /** Accept an explicit connection whose verified address is not this account's address. */
  allowIdentityMismatch?: boolean;
  config?: GoogleConfig;
  fetchImpl?: FetchLike;
  /** Run label discovery after the switch. Default true. */
  discoverLabels?: boolean;
}

const GOOGLE_SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/**
 * The scope a native Gmail transport needs.
 *
 * `gmail.modify` is what the adapter's own paths use — `messages.get/list/send/modify/delete`,
 * `labels.*`, `drafts.*`, `threads.*` and `history.list` — and it includes send. A Calendar or People
 * grant is a different authorization on the same connection and does **not** cover mail, which is why
 * the cutover checks the scope rather than the connection.
 */
export const REQUIRED_GMAIL_MAIL_SCOPE = 'gmail.modify';

/** A scope string without its resource prefix, lowercased. Google returns the full URL form. */
export function normaliseGoogleScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.toLowerCase().startsWith(GOOGLE_SCOPE_PREFIX)
    ? trimmed.slice(GOOGLE_SCOPE_PREFIX.length).toLowerCase()
    : trimmed.toLowerCase();
}

/** Which of the required scopes the grant does not cover; a more specific form covers the requirement. */
export function missingGmailMailScopes(scopes: readonly string[]): string[] {
  const granted = scopes.map(normaliseGoogleScope);
  return [REQUIRED_GMAIL_MAIL_SCOPE].filter(required => {
    const wanted = required.toLowerCase();
    return !granted.some(scope => scope === wanted || scope.startsWith(`${wanted}.`));
  });
}

function asMigrationState(value: unknown): GoogleMailMigrationState {
  return MIGRATION_STATES.find(state => state === value) ?? 'not_applicable';
}

interface AccountRow {
  id: string;
  email_address: string | null;
  oauth_provider: string | null;
  protocol: string | null;
  mail_transport: string | null;
  provider_connection_id: string | null;
  provider_mailbox_id: string | null;
  migration_state: string;
  migration_required: boolean;
  mail_method_preference: string | null;
  transport_generation: string | number;
}

interface ConnectionRow {
  id: string;
  subject: string | null;
  provider_user_id: string | null;
  status: string;
}

function toAccount(row: AccountRow): GoogleMailCutoverAccount {
  return {
    id: row.id,
    email_address: row.email_address,
    mail_transport: row.mail_transport,
    protocol: row.protocol,
    provider_connection_id: row.provider_connection_id,
    provider_mailbox_id: row.provider_mailbox_id,
    migration_state: asMigrationState(row.migration_state),
    migration_required: row.migration_required === true,
    mail_method_preference: row.mail_method_preference,
    transport_generation: Number(row.transport_generation),
  };
}

async function recordRefusal(
  client: PoolClient,
  account: AccountRow,
  state: GoogleMailMigrationState,
  code: GoogleMailCutoverRefusalCode,
): Promise<{ state: GoogleMailMigrationState; transition: GoogleMailMigrationTransition | null }> {
  const from = asMigrationState(account.migration_state);
  if (from === state) {
    await client.query('UPDATE email_accounts SET migration_error_code = $2 WHERE id = $1', [account.id, code]);
    return { state, transition: null };
  }
  await client.query(
    'UPDATE email_accounts SET migration_state = $2, migration_error_code = $3 WHERE id = $1',
    [account.id, state, code],
  );
  account.migration_state = state;
  return { state, transition: { from, to: state } };
}

/** The active Google grant of a connection, or null when it has none. */
async function readActiveGrant(client: PoolClient, connectionId: string): Promise<{ scopes: string[] } | null> {
  const result = await client.query<{ scopes: string[] | null }>(
    `SELECT scopes FROM oauth_grants
      WHERE connection_id = $1 AND audience = $2 AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1`,
    [connectionId, GOOGLE_GRANT_AUDIENCE],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { scopes: Array.isArray(row.scopes) ? row.scopes : [] };
}

/**
 * The Google connection a cutover binds the account to.
 *
 * An explicit choice must be a Google connection this user owns, and its verified identity must be this
 * mailbox unless the caller explicitly says the difference is intended — the switch must not silently move
 * the account onto a different mailbox. Without a choice, the connection whose verified address matches is
 * used; zero matches means the user has not authorized Gmail yet, and more than one is refused, not picked.
 */
async function resolveConnection(
  client: PoolClient,
  account: AccountRow,
  userId: string,
  explicitConnectionId: string | null,
  allowIdentityMismatch: boolean,
): Promise<
  | { kind: 'resolved'; connection: ConnectionRow }
  | { kind: 'refused'; httpStatus: number; code: GoogleMailCutoverRefusalCode; message: string }
> {
  if (explicitConnectionId) {
    const result = await client.query<ConnectionRow>(
      `SELECT id, subject, provider_user_id, status FROM provider_connections
        WHERE id = $1 AND user_id = $2 AND provider = 'google'`,
      [explicitConnectionId, userId],
    );
    const connection = result.rows[0];
    if (!connection) {
      return {
        kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_INVALID',
        message: 'That is not a Google connection of this user',
      };
    }
    const accountAddress = (account.email_address ?? '').trim().toLowerCase();
    const connectionAddress = (connection.provider_user_id ?? '').trim().toLowerCase();
    if (!allowIdentityMismatch && accountAddress && connectionAddress && accountAddress !== connectionAddress) {
      return {
        kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_IDENTITY_MISMATCH',
        message: `That connection belongs to ${connection.provider_user_id}, not to ${account.email_address}. `
          + 'Switching would read and send the other mailbox under this account. Pass allowIdentityMismatch: true if the difference is an alias you intend.',
      };
    }
    return { kind: 'resolved', connection };
  }

  const email = (account.email_address ?? '').trim();
  if (!email) {
    return {
      kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED',
      message: 'This account has no address to match a Google connection against; name the connection explicitly',
    };
  }
  const result = await client.query<ConnectionRow>(
    `SELECT id, subject, provider_user_id, status FROM provider_connections
      WHERE user_id = $1 AND provider = 'google'
        AND provider_user_id IS NOT NULL AND lower(provider_user_id) = lower($2)
      ORDER BY created_at ASC`,
    [userId, email],
  );
  if (result.rows.length === 0) {
    return {
      kind: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
      message: 'No Google authorization exists for this mailbox. Connect it to Google with the Gmail scope first.',
    };
  }
  if (result.rows.length > 1) {
    return {
      kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED',
      message: 'More than one Google connection matches this mailbox; name the connection explicitly',
    };
  }
  return { kind: 'resolved', connection: result.rows[0]! };
}

/**
 * Move one existing Google account onto the native Gmail API transport, in place.
 *
 * Returns a discriminated result rather than throwing: `not_found`, `not_applicable`, `refused`,
 * `already_native` or `migrated`. The caller maps it onto HTTP; no route logic lives here.
 */
export async function cutOverGoogleMailAccount(input: CutOverGoogleMailInput): Promise<GoogleMailCutoverResult> {
  const config = input.config ?? googleConfigFromEnv();
  const explicitConnectionId = input.connectionId ?? null;

  const outcome = await withTransaction<GoogleMailCutoverResult>(async client => {
    const locked = await client.query<AccountRow>(
      `SELECT id, email_address, oauth_provider, protocol, mail_transport, provider_connection_id,
              provider_mailbox_id, migration_state, migration_required, mail_method_preference,
              transport_generation
         FROM email_accounts
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.accountId, input.userId],
    );
    const account = locked.rows[0];
    if (!account) return { status: 'not_found' };
    const connections = await providerConnectionSignals(input.userId, client);

    // Already switched, with its connection recorded: a retry is a no-op, not a second migration.
    if (account.mail_transport === 'gmail_api' && account.provider_connection_id) {
      return {
        status: 'already_native',
        account: toAccount(account),
        connectionId: account.provider_connection_id,
        transitions: [],
      };
    }

    // The account's provider is decided by the shared classifier, not by `oauth_provider` alone: a mailbox
    // added from a 4.0.4 preset over IMAP with an app password has a Gmail host and a NULL `oauth_provider`,
    // and it is exactly the account this cutover exists for. The classification only says "candidate"; the
    // connection, ownership, verified identity and scope checks below still decide whether a switch happens.
    const kind = classifyProviderAccount({ ...account, connections });
    if (kind !== 'google') {
      return {
        status: 'not_applicable',
        reason: 'This account is not a Google account, so there is no Gmail API transport to cut it over to',
      };
    }
    if (account.mail_transport && account.mail_transport !== 'imap_smtp') {
      return {
        status: 'not_applicable',
        reason: `This account already uses the ${account.mail_transport} transport`,
      };
    }

    if (!providerIntegrationsEnabled()) {
      const recorded = await recordRefusal(client, account, 'admin_configuration_required', 'PROVIDER_INTEGRATIONS_DISABLED');
      return {
        status: 'refused', httpStatus: 403, code: 'PROVIDER_INTEGRATIONS_DISABLED',
        message: 'Provider integrations are disabled on this installation',
        migrationState: recorded.state, recorded: true,
      };
    }
    if (!isGoogleConfigured(config)) {
      const recorded = await recordRefusal(client, account, 'admin_configuration_required', 'GOOGLE_NOT_CONFIGURED');
      return {
        status: 'refused', httpStatus: 409, code: 'GOOGLE_NOT_CONFIGURED',
        message: 'Google API is not configured by the administrator',
        migrationState: recorded.state, recorded: true,
      };
    }

    const resolved = await resolveConnection(client, account, input.userId, explicitConnectionId, input.allowIdentityMismatch === true);
    if (resolved.kind === 'refused') {
      // Only a missing authorization is an account state worth recording; a malformed or ambiguous
      // connection choice is a request error the caller fixes and retries immediately.
      if (resolved.code !== 'PROVIDER_AUTH_REQUIRED') {
        return {
          status: 'refused', httpStatus: resolved.httpStatus, code: resolved.code,
          message: resolved.message, migrationState: null, recorded: false,
        };
      }
      const recorded = await recordRefusal(client, account, 'authorization_required', resolved.code);
      return {
        status: 'refused', httpStatus: resolved.httpStatus, code: resolved.code,
        message: resolved.message, migrationState: recorded.state, recorded: true,
      };
    }

    const connection = resolved.connection;
    if (connection.status !== 'active') {
      const recorded = await recordRefusal(client, account, 'authorization_required', 'PROVIDER_AUTH_REQUIRED');
      return {
        status: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
        message: `The Google connection is ${connection.status}; authorize it again to use the Gmail API transport`,
        migrationState: recorded.state, recorded: true,
      };
    }

    const grant = await readActiveGrant(client, connection.id);
    const missingScopes = missingGmailMailScopes(grant?.scopes ?? []);
    if (!grant || missingScopes.length) {
      // A Calendar/People authorization is not a mail authorization: without the Gmail scope the transport
      // cannot read, label, draft or send, so nothing is switched and the account stays on IMAP/SMTP.
      const recorded = await recordRefusal(client, account, 'authorization_required', 'PROVIDER_AUTH_REQUIRED');
      return {
        status: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
        message: grant
          ? `The Google grant is missing the scope the Gmail transport needs: ${missingScopes.join(', ')}. Authorize the mailbox again with Gmail access.`
          : 'The Google connection has no active grant; authorize it again with Gmail access',
        missingScopes,
        migrationState: recorded.state, recorded: true,
      };
    }

    // The switch: transport, connection and state in one statement. `protocol` is the legacy field the
    // reconnect and health-check loops still read, so leaving it 'imap' would reopen the mailbox over IMAP —
    // precisely the silent fallback this cutover forbids.
    const mailboxId = connection.subject ?? connection.provider_user_id ?? account.email_address;
    const updated = await client.query<AccountRow>(
      `UPDATE email_accounts
          SET mail_transport = 'gmail_api',
              protocol = 'gmail_api',
              provider_connection_id = $2,
              provider_mailbox_id = COALESCE(provider_mailbox_id, $3),
              mail_method_preference = 'gmail_api',
              transport_generation = transport_generation + 1,
              migration_state = 'active_native',
              migration_required = false,
              migration_error_code = NULL
        WHERE id = $1 AND user_id = $4
        RETURNING id, email_address, oauth_provider, protocol, mail_transport, provider_connection_id,
                  provider_mailbox_id, migration_state, migration_required, mail_method_preference,
                  transport_generation`,
      [account.id, connection.id, mailboxId, input.userId],
    );
    const row = updated.rows[0];
    if (!row) return { status: 'not_found' };

    const from = asMigrationState(account.migration_state);
    const transitions: GoogleMailMigrationTransition[] = from === 'active_native'
      ? []
      : [{ from, to: 'active_native' }];
    return { status: 'migrated', account: toAccount(row), connectionId: connection.id, transitions, labelsDiscovered: false, labels: 0 };
  });

  if (outcome.status !== 'migrated' || input.discoverLabels === false) return outcome;

  // After the switch has committed: give the refresh schedule the first `mail_label` collection it needs,
  // because it only visits collections that already exist. A provider failure here does not un-migrate
  // anything — the transport is native and the next sync retries the discovery.
  try {
    const discovery = await syncGmailMailLabelsForAccount({
      userId: input.userId,
      connectionId: outcome.connectionId,
      accountId: outcome.account.id,
      config,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { ...outcome, labelsDiscovered: true, labels: discovery.labels ?? 0 };
  } catch (caught) {
    console.warn(
      `Gmail label discovery after cutover failed for account ${outcome.account.id}:`,
      caught instanceof Error ? caught.message : caught,
    );
    return { ...outcome, labelsDiscovered: false, labels: 0 };
  }
}
