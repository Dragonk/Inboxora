import { toAppError } from '../../utils/errors.js';
import type { EmailAccountRow } from '../imapManager.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../providerMutationService.js';

/**
 * The first production adapter on the shared mutation layer (P03): a flag write on
 * a message over IMAP.
 *
 * It exists to prove the layer carries a real write path, and it is deliberately a
 * small one. Setting `\Seen` or `\Flagged` to a value **converges**: applying it
 * twice leaves the same state only while that intent is current. Recovered claims
 * require readback because a later remote or local edit may have superseded them. That is the opposite of the send case, and the
 * layer keys its recovery decision on exactly this declaration.
 */

export interface ImapFlagWrite {
  uid: number | string;
  folder: string;
  flag: string;
  value: boolean;
}

export type ImapFlagWriter = (
  account: EmailAccountRow,
  uid: number | string,
  folder: string,
  flag: string,
  value: boolean,
) => Promise<unknown>;

/**
 * Classify an IMAP failure for the journal.
 *
 * The default is `outcome_unknown`, not `retryable`, and that is the honest
 * reading: when a connection drops mid-command, IMAP gives no evidence whether
 * the server applied the `STORE`. Marking it retryable would license an automatic
 * re-run of a mutation that may already have happened.
 */
export function classifyImapFlagFailure(error: unknown): ProviderAdapterOutcome<void> {
  const failure = toAppError(error);
  if (failure.code === 'MAIL_FLAG_NOT_DISPATCHED') return { status: 'retryable', code: failure.code };
  if (failure.code === 'MAIL_IDENTITY_CHANGED' || failure.code === 'RESOURCE_NOT_FOUND') return { status: 'permanent', code: failure.code };
  const text = `${failure.code ?? ''} ${failure.message ?? ''}`;
  if (/auth|credential|login|AUTHENTICATIONFAILED|Invalid credentials/i.test(text)) {
    return { status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
  }
  if (/nonexistent|not found|no such|mailbox does not exist/i.test(text)) {
    return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
  }
  return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
}

export function imapFlagMutationAdapter(options: {
  account: EmailAccountRow;
  write: ImapFlagWrite;
  setFlag: ImapFlagWriter;
}): ProviderMutationAdapter<void, void> {
  return {
    resourceType: 'message',
    // A lost response is reconciled from current truth, never replayed over a later edit.
    idempotent: false,
    async perform() {
      try {
        await options.setFlag(options.account, options.write.uid, options.write.folder, options.write.flag, options.write.value);
        return { status: 'committed' };
      } catch (error) {
        return classifyImapFlagFailure(error);
      }
    },
  };
}
