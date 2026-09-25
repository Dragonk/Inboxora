import { runProviderMutation } from './providerMutationService.js';
import type { ProviderMutationStatus } from './providerMutationService.js';
import { imapFlagMutationAdapter } from './providers/imapFlagMutation.js';
import {
  graphFlagIntent,
  graphFlagMutationAdapter,
  type GraphMailFlagPayload,
} from './providers/microsoft/graphMailMutations.js';
import {
  gmailFlagIntent,
  gmailFlagMutationAdapter,
  type GmailMailFlagPayload,
} from './providers/google/gmailMailMutations.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { toAppError } from '../utils/errors.js';
import type { EmailAccountRow } from './imapManager.js';

/**
 * Push a flag change to whichever transport owns the message (P03, and MAIL-01's prerequisite).
 *
 * The journal records the intent and its outcome durably, so a process that dies between the transport write and
 * the local bookkeeping leaves evidence rather than a silently lost change. The in-memory flag-push reconciler is
 * still the retry vehicle for anything the layer does not confirm — it existed before the layer and is not
 * replaced here; a later slice can hand that job to the journal's own `pending` state.
 *
 * No idempotency key is sent: each click is a new intent to set the flag, and the journal's replay answers a
 * retry of the *same* intent, which this interface does not send. A journal that is unavailable degrades to the
 * previous behaviour (queue for the reconciler) rather than failing the user's action.
 *
 * The IMAP side of the write is injected as a port. It used to be the `imapManager` singleton imported from the
 * application root, which is what kept this code inside the route module: a service that imported the root would
 * close an import cycle. Naming the three methods it needs lets the write live beside the provider adapters it
 * dispatches to, and lets the ingest rules reach it too.
 */
export interface ImapFlagPort {
  setFlag(account: EmailAccountRow, uid: number | string, folder: string, flag: string, value: boolean): Promise<unknown>;
  _resolveFlagPush(accountId: string, messageId: string, flag: string): void;
  _enqueueFlagPush(accountId: string, messageId: string, flag: string, value: boolean): void;
}

export interface FlagWriteOptions {
  userId: string;
  account: EmailAccountRow;
  accountId: string;
  messageId: string;
  /** The provider's own message id; absent for an IMAP row. */
  providerMessageId?: string | null;
  uid: number | string;
  folder: string;
  flag: string;
  value: boolean;
}

/**
 * Set a flag on one message, over the transport that owns it.
 *
 * The transport decides which adapter runs. A native account has no IMAP session to write to, and an IMAP account
 * has no Graph message id; dispatching here is what keeps the two paths from pretending to be each other.
 */
export async function pushProviderMessageFlag(
  options: FlagWriteOptions & { manager: ImapFlagPort },
): Promise<{ status: ProviderMutationStatus; code?: string }> {
  const { account, accountId, messageId, uid, folder, flag, value, manager } = options;
  if (account.mail_transport === 'microsoft_graph') {
    return pushGraphMessageFlag(options);
  }
  if (account.mail_transport === 'gmail_api') {
    return pushGmailMessageFlag(options);
  }
  let status: ProviderMutationStatus = 'outcome_unknown';
  let code: string | undefined;
  try {
    const mutation = await runProviderMutation<void, void>(
      {
        userId: options.userId,
        channel: 'web',
        operation: 'update',
        accountId,
        resourceId: messageId,
        payload: undefined,
      },
      imapFlagMutationAdapter({
        account,
        write: { uid, folder, flag, value },
        setFlag: (target, targetUid, targetFolder, targetFlag, targetValue) =>
          manager.setFlag(target, targetUid, targetFolder, targetFlag, targetValue),
      }),
    );
    status = mutation.status;
    code = mutation.code;
    if (mutation.status === 'confirmed') {
      manager._resolveFlagPush(accountId, messageId, flag); // confirmed — drop any stale queued op
      return { status };
    }
    console.error(`IMAP flag update not confirmed (${mutation.status}${mutation.code ? `, ${mutation.code}` : ''})`);
  } catch (caught) {
    // The claim itself could not be written (migration missing, database down).
    // That must not lose the user's change, so fall through to the reconciler.
    console.error('Provider mutation journal unavailable for a flag write:', toAppError(caught).message);
    code = 'MUTATION_OUTCOME_UNKNOWN';
  }
  // Push failed or was not confirmed — queue a durable retry so a later flag-sync
  // pull can't silently revert the user's change once the 30s local-wins window
  // lapses.
  manager._enqueueFlagPush(accountId, messageId, flag, value);
  return { status, ...(code ? { code } : {}) };
}

/**
 * The Microsoft Graph flag write, on the same journal as the IMAP one.
 *
 * Two differences from the IMAP path are deliberate. The intent carries an `intentAt`, which makes its idempotency
 * key unique per user action **and** derivable from the stored payload, so a scheduled retry reclaims its own row
 * while a later click of the same control is a new operation rather than a replay of an old result. And a failure
 * is **not** handed to the IMAP flag-push reconciler — that queue writes over IMAP — so a `retryable` outcome is
 * scheduled in the journal and drained by the next message sync instead.
 */
export async function pushGraphMessageFlag(options: {
  userId: string;
  account: EmailAccountRow;
  accountId: string;
  messageId: string;
  providerMessageId?: string | null;
  flag: string;
  value: boolean;
}): Promise<{ status: ProviderMutationStatus; code?: string }> {
  const { account, accountId, messageId, flag, value } = options;
  if (!account.provider_connection_id) {
    return { status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  }
  // Without the provider's own id there is nothing to address; saying so is better
  // than queueing a retry that can never succeed.
  if (!options.providerMessageId) {
    console.error('Graph flag update skipped: the local message carries no provider id');
    return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
  }

  const payload: GraphMailFlagPayload = {
    providerMessageId: options.providerMessageId,
    flag,
    value,
    intentAt: new Date().toISOString(),
  };
  const { idempotencyKey, payloadHash } = graphFlagIntent({ messageId, write: payload });
  try {
    const mutation = await runProviderMutation<GraphMailFlagPayload, void>(
      {
        userId: options.userId,
        channel: 'web',
        operation: 'update',
        accountId,
        resourceId: messageId,
        idempotencyKey,
        payloadHash,
        payload,
        retry: { delaySeconds: 300 },
      },
      graphFlagMutationAdapter({
        api: { userId: options.userId, connectionId: account.provider_connection_id, config: microsoftConfigFromEnv() },
      }),
    );
    if (mutation.status === 'confirmed') return { status: mutation.status };
    console.error(`Graph flag update not confirmed (${mutation.status}${mutation.code ? `, ${mutation.code}` : ''})`);
    return { status: mutation.status, ...(mutation.code ? { code: mutation.code } : {}) };
  } catch (caught) {
    console.error('Provider mutation journal unavailable for a Graph flag write:', toAppError(caught).message);
    return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
  }
}

/**
 * The Gmail flag write, on the same journal as the IMAP and Graph ones.
 *
 * A flag on Gmail is a label: `\Seen` is the absence of `UNREAD` and `\Flagged` is `STARRED`, so the write is an
 * add/remove that converges and is declared idempotent. As for Graph, a failure is **not** handed to the IMAP
 * flag-push reconciler — that queue writes over IMAP — so a `retryable` outcome is scheduled in the journal and
 * drained by the next message sync instead.
 */
export async function pushGmailMessageFlag(options: {
  userId: string;
  account: EmailAccountRow;
  accountId: string;
  messageId: string;
  providerMessageId?: string | null;
  flag: string;
  value: boolean;
}): Promise<{ status: ProviderMutationStatus; code?: string }> {
  const { account, accountId, messageId, flag, value } = options;
  if (!account.provider_connection_id) {
    return { status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  }
  if (!options.providerMessageId) {
    console.error('Gmail flag update skipped: the local message carries no provider id');
    return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
  }

  const payload: GmailMailFlagPayload = {
    providerMessageId: options.providerMessageId,
    flag,
    value,
    intentAt: new Date().toISOString(),
  };
  const { idempotencyKey, payloadHash } = gmailFlagIntent({ messageId, write: payload });
  try {
    const mutation = await runProviderMutation<GmailMailFlagPayload, void>(
      {
        userId: options.userId,
        channel: 'web',
        operation: 'update',
        accountId,
        resourceId: messageId,
        idempotencyKey,
        payloadHash,
        payload,
        retry: { delaySeconds: 300 },
      },
      gmailFlagMutationAdapter({
        api: { userId: options.userId, connectionId: account.provider_connection_id, config: googleConfigFromEnv() },
      }),
    );
    if (mutation.status === 'confirmed') return { status: mutation.status };
    console.error(`Gmail flag update not confirmed (${mutation.status}${mutation.code ? `, ${mutation.code}` : ''})`);
    return { status: mutation.status, ...(mutation.code ? { code: mutation.code } : {}) };
  } catch (caught) {
    console.error('Provider mutation journal unavailable for a Gmail flag write:', toAppError(caught).message);
    return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
  }
}
