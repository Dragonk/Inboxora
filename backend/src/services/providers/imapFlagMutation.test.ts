import { describe, expect, it, vi } from 'vitest';
import type { EmailAccountRow } from '../imapManager.js';
import { classifyImapFlagFailure, imapFlagMutationAdapter } from './imapFlagMutation.js';

const account = { id: 'account-1' } as EmailAccountRow;
const write = { uid: 42, folder: 'INBOX', flag: '\\Seen', value: true };

describe('the IMAP flag adapter on the mutation layer', () => {
  it('reports a committed outcome and writes the flag once', async () => {
    const setFlag = vi.fn(async () => undefined);
    const adapter = imapFlagMutationAdapter({ account, write, setFlag });

    expect(adapter.idempotent).toBe(true);
    expect(adapter.resourceType).toBe('message');
    await expect(adapter.perform(undefined, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed' });
    expect(setFlag).toHaveBeenCalledWith(account, 42, 'INBOX', '\\Seen', true);
  });

  it('classifies an authentication failure as permanent', async () => {
    const adapter = imapFlagMutationAdapter({
      account, write,
      setFlag: async () => { throw Object.assign(new Error('AUTHENTICATIONFAILED Invalid credentials'), { code: 'AUTH' }); },
    });
    const outcome = await adapter.perform(undefined, { operationId: 'op-1', signal: new AbortController().signal });
    expect(outcome).toEqual({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
  });

  it('classifies a vanished mailbox as a permanent missing resource', () => {
    expect(classifyImapFlagFailure(Object.assign(new Error('Mailbox does not exist'), { code: 'NONEXISTENT' })))
      .toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
  });

  it('treats an unclassified connection failure as an unknown outcome, not a retry', () => {
    // IMAP gives no evidence whether a `STORE` reached the server when the socket
    // drops, so an automatic retry would be able to double-apply it.
    expect(classifyImapFlagFailure(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })))
      .toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(classifyImapFlagFailure(new Error('whatever'))).toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});
