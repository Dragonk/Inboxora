import { toAppError } from '../../utils/errors.js';
import type { EmailAccountRow } from '../imapManager.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../providerMutationService.js';

/**
 * The first production adapter on the shared mutation layer (P03): a flag write on
 * a message over IMAP.
 *
 * It exists to prove the layer carries a real write path, and it is deliberately a
 * small one. Setting `\Seen` or `\Flagged` to a value **converges**: applying it
 * twice leaves the same state, so the adapter declares itself `idempotent` and a
 * recovered claim may re-run it. That is the opposite of the send case, and the
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
    // Re-applying a flag converges on the same state, so a recovered claim is safe
    // to run again.
    idempotent: true,
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
