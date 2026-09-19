import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  isMicrosoftConfigured,
  microsoftConfigFromEnv,
} from './providerAuthService.js';
import type { FetchLike } from './providerAuthService.js';
import { syncGraphMailFoldersForAccount } from './providers/microsoft/graphMailSync.js';
import type { GraphApiOptions } from './providers/microsoft/graphApiClient.js';

/**
 * P12 — the in-place Microsoft Graph mail cutover.
 *
 * An account that has been reading Microsoft mail over OAuth2 IMAP/SMTP moves to the native Graph
 * transport **without changing its identity**: the same `email_accounts.id`, the same messages,
 * folders, drafts and conversations, and no second account for the same mailbox.
 *
 * Two rules decide the shape of this module.
 *
 * **The switch is deliberate and verifiable.** It happens only when the account resolves to an
 * active Graph provider connection whose grant actually carries the mail scopes the native paths
 * need (`Mail.ReadWrite` for sync, filing and flags; `Mail.Send` because a native account sends
 * over Graph — `sendTransport.ts` has no SMTP branch for it). A caller may name the connection
 * explicitly; otherwise the connection whose verified identity is this mailbox is resolved, and an
 * ambiguous match is refused rather than guessed.
 *
 * **The switch is atomic and idempotent.** The transport, the connection it is bound to, the
 * `migration_state` and the cleared `migration_error_code` are written in **one** UPDATE inside one
 * transaction, guarded by `SELECT … FOR UPDATE` on the account row. A crash anywhere leaves either
 * the whole switch or none of it; there is deliberately no persisted intermediate `switching` state,
 * because a durable "half switched" row is exactly the state this package forbids. A second call on
 * an already-native account is a no-op and does not touch the row again.
 *
 * The state values are the ones migration `0101` already declares — no new column is invented. A
 * refusal that is the account's or the administrator's to fix is recorded as
 * `authorization_required` or `admin_configuration_required` with the reason in
 * `migration_error_code`, and that write never touches the transport or the connection: mail keeps
 * flowing exactly as it did before the attempt.
 */

/** The `email_accounts.migration_state` values migration `0101` allows. */
export type MicrosoftMailMigrationState =
  | 'not_applicable'
  | 'available'
  | 'classified'
  | 'authorization_required'
  | 'admin_configuration_required'
  | 'authorized'
  | 'inventory'
  | 'backfill'
  | 'reconcile'
  | 'ready_to_switch'
  | 'draining'
  | 'switching'
  | 'active_native'
  | 'paused'
  | 'failed_retryable'
  | 'needs_review';

const MIGRATION_STATES: readonly MicrosoftMailMigrationState[] = [
  'not_applicable', 'available', 'classified', 'authorization_required',
  'admin_configuration_required', 'authorized', 'inventory', 'backfill',
  'reconcile', 'ready_to_switch', 'draining', 'switching', 'active_native',
  'paused', 'failed_retryable', 'needs_review',
];

/** One recorded `migration_state` change. `from` is what the row held before the call. */
export interface MicrosoftMailMigrationTransition {
  from: MicrosoftMailMigrationState;
  to: MicrosoftMailMigrationState;
}

/** Why a cutover was refused, and therefore what the caller can do about it. */
export type MicrosoftMailCutoverRefusalCode =
  | 'ACCOUNT_MIGRATION_NOT_APPLICABLE'
  | 'PROVIDER_INTEGRATIONS_DISABLED'
  | 'MICROSOFT_NOT_CONFIGURED'
  | 'ACCOUNT_MIGRATION_CONNECTION_INVALID'
  | 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED'
  | 'PROVIDER_AUTH_REQUIRED';

/** The account fields the result carries; a subset of the row, with the migration state narrowed. */
export interface MicrosoftMailCutoverAccount {
  id: string;
  email_address: string | null;
  mail_transport: string | null;
  protocol: string | null;
  provider_connection_id: string | null;
  provider_mailbox_id: string | null;
  migration_state: MicrosoftMailMigrationState;
  migration_required: boolean;
  mail_method_preference: string | null;
  transport_generation: number;
}

export type MicrosoftMailCutoverResult =
  | { status: 'not_found' }
  | { status: 'not_applicable'; reason: string }
  | {
      status: 'refused';
      httpStatus: number;
      code: MicrosoftMailCutoverRefusalCode;
      message: string;
      /** The Graph scopes the grant is missing, when the refusal is about the grant. */
      missingScopes?: string[];
      /** The state recorded for the refusal, or null when nothing was written. */
      migrationState: MicrosoftMailMigrationState | null;
      recorded: boolean;
    }
  | { status: 'already_native'; account: MicrosoftMailCutoverAccount; connectionId: string; transitions: MicrosoftMailMigrationTransition[] }
  | {
      status: 'migrated';
      account: MicrosoftMailCutoverAccount;
      connectionId: string;
      transitions: MicrosoftMailMigrationTransition[];
      /** Whether folder discovery ran and created the collections the schedule needs. */
      foldersDiscovered: boolean;
      folders: number;
    };

export interface CutOverMicrosoftMailInput {
  userId: string;
  accountId: string;
  /**
   * The connection the caller chose. Optional: without it the mailbox's own connection is resolved
   * from the verified provider identity, and an ambiguous match is refused rather than guessed.
   */
  connectionId?: string | null;
  /** Overrides the environment configuration (tests inject one). */
  config?: GraphApiOptions['config'];
  fetchImpl?: FetchLike;
  /**
   * Run folder discovery after the switch. Default true: without it a freshly cut-over account has no
   * `mail_folder` collection, and the refresh schedule only visits collections that already exist.
   * The switch itself never depends on the provider answering.
   */
  discoverFolders?: boolean;
}

const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';

/**
 * The delegated Graph scopes a native mail transport needs. Read/write because sync writes flags,
 * moves, deletes and drafts; send because a native account sends over Graph.
 */
export const REQUIRED_GRAPH_MAIL_SCOPES: readonly string[] = ['Mail.ReadWrite', 'Mail.Send'];

/**
 * A scope string without its resource prefix, lowercased. Microsoft returns the full
 * `https://graph.microsoft.com/Mail.ReadWrite` form in the token response, but a stored grant may
 * hold either the full or the short form, and the comparison must not depend on which.
 */
export function normaliseGraphScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX)
    ? trimmed.slice(GRAPH_SCOPE_PREFIX.length).toLowerCase()
    : trimmed.toLowerCase();
}

/**
 * Which of the required scopes the grant does not cover. A scope covers a requirement when it is the
 * requirement or a more specific form of it (`Mail.ReadWrite.All`, `Mail.Send.Shared`), so a tenant
 * that granted a superset is not refused for holding the wrong spelling.
 */
export function missingGraphMailScopes(scopes: readonly string[]): string[] {
  const granted = scopes.map(normaliseGraphScope);
  return REQUIRED_GRAPH_MAIL_SCOPES.filter(required => {
    const wanted = required.toLowerCase();
    return !granted.some(scope => scope === wanted || scope.startsWith(`${wanted}.`));
  });
}

/** Narrow the column's text to the state union; anything unrecognised is treated as unclassified. */
function asMigrationState(value: unknown): MicrosoftMailMigrationState {
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

function toAccount(row: AccountRow): MicrosoftMailCutoverAccount {
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

/**
 * Record a refusal in `migration_state` / `migration_error_code` without touching the transport.
 *
 * This is a complete, atomic write of its own: the account keeps reading and sending exactly as it
 * did, and the reason is visible to whoever renders the account. When the state is already the one
 * being recorded only the error code is refreshed, and no transition is reported.
 */
async function recordRefusal(
  client: PoolClient,
  account: AccountRow,
  state: MicrosoftMailMigrationState,
  code: MicrosoftMailCutoverRefusalCode,
): Promise<{ state: MicrosoftMailMigrationState; transition: MicrosoftMailMigrationTransition | null }> {
  const from = asMigrationState(account.migration_state);
  if (from === state) {
    await client.query(
      'UPDATE email_accounts SET migration_error_code = $2 WHERE id = $1',
      [account.id, code],
    );
    return { state, transition: null };
  }
  await client.query(
    'UPDATE email_accounts SET migration_state = $2, migration_error_code = $3 WHERE id = $1',
    [account.id, state, code],
  );
  account.migration_state = state;
  return { state, transition: { from, to: state } };
}

/** The active Microsoft Graph grant of a connection, or null when it has none. */
async function readActiveGrant(client: PoolClient, connectionId: string): Promise<{ scopes: string[] } | null> {
  const result = await client.query<{ scopes: string[] | null }>(
    `SELECT scopes FROM oauth_grants
      WHERE connection_id = $1 AND audience = $2 AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1`,
    [connectionId, MICROSOFT_GRANT_AUDIENCE],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { scopes: Array.isArray(row.scopes) ? row.scopes : [] };
}

/**
 * The Microsoft connection a cutover binds the account to.
 *
 * An explicit choice must be a Microsoft connection this user owns. Without one, the connection whose
 * verified provider identity is this mailbox is used, case-insensitively; zero matches means the user
 * has not authorized Graph for this mailbox yet, and more than one is refused instead of picked.
 */
async function resolveConnection(
  client: PoolClient,
  account: AccountRow,
  userId: string,
  explicitConnectionId: string | null,
): Promise<
  | { kind: 'resolved'; connection: ConnectionRow }
  | { kind: 'refused'; httpStatus: number; code: MicrosoftMailCutoverRefusalCode; message: string }
> {
  if (explicitConnectionId) {
    const result = await client.query<ConnectionRow>(
      `SELECT id, subject, provider_user_id, status FROM provider_connections
        WHERE id = $1 AND user_id = $2 AND provider = 'microsoft'`,
      [explicitConnectionId, userId],
    );
    const connection = result.rows[0];
    if (!connection) {
      return {
        kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_INVALID',
        message: 'That is not a Microsoft connection of this user',
      };
    }
    return { kind: 'resolved', connection };
  }

  const email = (account.email_address ?? '').trim();
  if (!email) {
    return {
      kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED',
      message: 'This account has no address to match a Microsoft connection against; name the connection explicitly',
    };
  }
  const result = await client.query<ConnectionRow>(
    `SELECT id, subject, provider_user_id, status FROM provider_connections
      WHERE user_id = $1 AND provider = 'microsoft'
        AND provider_user_id IS NOT NULL AND lower(provider_user_id) = lower($2)
      ORDER BY created_at ASC`,
    [userId, email],
  );
  if (result.rows.length === 0) {
    return {
      kind: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
      message: 'No Microsoft Graph authorization exists for this mailbox. Connect it to Microsoft first.',
    };
  }
  if (result.rows.length > 1) {
    return {
      kind: 'refused', httpStatus: 409, code: 'ACCOUNT_MIGRATION_CONNECTION_REQUIRED',
      message: 'More than one Microsoft connection matches this mailbox; name the connection explicitly',
    };
  }
  return { kind: 'resolved', connection: result.rows[0]! };
}

/**
 * Move one existing Microsoft account onto the native Graph transport, in place.
 *
 * Returns a discriminated result rather than throwing: `not_found`, `not_applicable`, `refused`,
 * `already_native` or `migrated`. The caller maps the result onto HTTP; no route logic lives here.
 */
export async function cutOverMicrosoftMailAccount(
  input: CutOverMicrosoftMailInput,
): Promise<MicrosoftMailCutoverResult> {
  const config = input.config ?? microsoftConfigFromEnv();
  const explicitConnectionId = input.connectionId ?? null;

  const outcome = await withTransaction<MicrosoftMailCutoverResult>(async client => {
    // Lock the account for the whole decision: two concurrent cutovers for one account serialize
    // here, and the second one observes the first one's committed switch.
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

    // Already switched, with its connection recorded: a retry is a no-op, not a second migration.
    if (account.mail_transport === 'microsoft_graph' && account.provider_connection_id) {
      return {
        status: 'already_native',
        account: toAccount(account),
        connectionId: account.provider_connection_id,
        transitions: [],
      };
    }

    if (account.oauth_provider !== 'microsoft') {
      return {
        status: 'not_applicable',
        reason: 'This account is not a Microsoft account, so there is no Graph transport to cut it over to',
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
    if (!isMicrosoftConfigured(config)) {
      const recorded = await recordRefusal(client, account, 'admin_configuration_required', 'MICROSOFT_NOT_CONFIGURED');
      return {
        status: 'refused', httpStatus: 409, code: 'MICROSOFT_NOT_CONFIGURED',
        message: 'Microsoft API is not configured by the administrator',
        migrationState: recorded.state, recorded: true,
      };
    }

    const resolved = await resolveConnection(client, account, input.userId, explicitConnectionId);
    if (resolved.kind === 'refused') {
      // Only a missing authorization is an account state worth recording. A malformed or ambiguous
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
        message: `The Microsoft connection is ${connection.status}; authorize it again to use the Graph transport`,
        migrationState: recorded.state, recorded: true,
      };
    }

    const grant = await readActiveGrant(client, connection.id);
    const missingScopes = missingGraphMailScopes(grant?.scopes ?? []);
    if (!grant || missingScopes.length) {
      const recorded = await recordRefusal(client, account, 'authorization_required', 'PROVIDER_AUTH_REQUIRED');
      return {
        status: 'refused', httpStatus: 409, code: 'PROVIDER_AUTH_REQUIRED',
        message: grant
          ? `The Microsoft grant is missing the scopes the Graph transport needs: ${missingScopes.join(', ')}`
          : 'The Microsoft connection has no active Graph grant; authorize it again',
        missingScopes,
        migrationState: recorded.state, recorded: true,
      };
    }

    // The switch: transport, connection and state in one statement, so a crash between them is
    // impossible. `protocol` is the legacy field the IMAP loops still filter on (`health-check`,
    // `syncNow`, `connectAllForUser`), so leaving it 'imap' would reconnect the mailbox over IMAP —
    // precisely the silent fallback this cutover forbids.
    const mailboxId = connection.subject ?? connection.provider_user_id ?? account.email_address;
    const updated = await client.query<AccountRow>(
      `UPDATE email_accounts
          SET mail_transport = 'microsoft_graph',
              protocol = 'microsoft_graph',
              provider_connection_id = $2,
              provider_mailbox_id = COALESCE(provider_mailbox_id, $3),
              mail_method_preference = 'microsoft_graph',
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
    const transitions: MicrosoftMailMigrationTransition[] = from === 'active_native'
      ? []
      : [{ from, to: 'active_native' }];
    return { status: 'migrated', account: toAccount(row), connectionId: connection.id, transitions, foldersDiscovered: false, folders: 0 };
  });

  if (outcome.status !== 'migrated' || input.discoverFolders === false) return outcome;

  // After the switch has committed: give the refresh schedule the first `mail_folder` collection it
  // needs, because it only ever visits collections that already exist. A provider failure here does
  // not un-migrate anything — the transport is native, and the next sync retries the discovery.
  try {
    const discovery = await syncGraphMailFoldersForAccount({
      userId: input.userId,
      connectionId: outcome.connectionId,
      accountId: outcome.account.id,
      ...(input.config ? { config: input.config } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { ...outcome, foldersDiscovered: true, folders: discovery.folders };
  } catch (caught) {
    console.warn(
      `Graph mail folder discovery after cutover failed for account ${outcome.account.id}:`,
      caught instanceof Error ? caught.message : caught,
    );
    return { ...outcome, foldersDiscovered: false, folders: 0 };
  }
}
