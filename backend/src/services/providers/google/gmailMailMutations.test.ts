import { describe, expect, it, vi } from 'vitest';
import {
  classifyGmailMailMutationFailure,
  gmailDeleteIntent,
  gmailDeleteMutationAdapter,
  gmailFlagIntent,
  gmailFlagMutationAdapter,
  gmailLabelChangeForFlag,
  gmailLabelCreateAdapter,
  gmailMoveIntent,
  gmailMoveMutationAdapter,
} from './gmailMailMutations.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import type { GmailMailFlagPayload, GmailMailMovePayload } from './gmailMailMutations.js';

const API: GoogleApiOptions = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

describe('a Gmail flag as a label change', () => {
  it('maps read to the absence of UNREAD and star to STARRED', () => {
    // Gmail's only unread marker is the UNREAD label, so "read" is removing it.
    expect(gmailLabelChangeForFlag('\\Seen', true)).toEqual({ add: [], remove: ['UNREAD'] });
    expect(gmailLabelChangeForFlag('\\Seen', false)).toEqual({ add: ['UNREAD'], remove: [] });
    expect(gmailLabelChangeForFlag('\\Flagged', true)).toEqual({ add: ['STARRED'], remove: [] });
    expect(gmailLabelChangeForFlag('\\Flagged', false)).toEqual({ add: [], remove: ['STARRED'] });
  });

  it('refuses a flag Gmail has no equivalent for instead of silently doing nothing', () => {
    expect(gmailLabelChangeForFlag('\\Answered', true)).toBeNull();
    expect(gmailLabelChangeForFlag('\\Deleted', true)).toBeNull();
  });
});

describe('classifying a Gmail mutation failure', () => {
  it('keeps the provider class for a readable answer and parks everything else', () => {
    const limited = new GoogleApiError({ code: 'RATE_LIMITED', message: 'slow down', status: 429, retryable: true, retryAfterSeconds: 30 });
    expect(classifyGmailMailMutationFailure(limited)).toEqual({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 30 });

    const missing = new GoogleApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 });
    expect(classifyGmailMailMutationFailure(missing)).toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });

    // A timeout or a connection loss cannot tell us whether Gmail applied the change.
    expect(classifyGmailMailMutationFailure(new Error('socket hang up'))).toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(classifyGmailMailMutationFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      .toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});

describe('the Gmail flag mutation adapter', () => {
  const payload: GmailMailFlagPayload = { providerMessageId: 'm1', flag: '\\Seen', value: true, intentAt: '2026-09-01T00:00:00.000Z' };

  it('is declared idempotent, because the write is a state set', () => {
    expect(gmailFlagMutationAdapter({ api: API }).idempotent).toBe(true);
  });

  it('performs the label change and reports it committed', async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = gmailFlagMutationAdapter({ api: API, modify });
    await expect(adapter.perform(payload, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed' });
    expect(modify).toHaveBeenCalledWith(API, 'm1', [], ['UNREAD']);
  });

  it('refuses an unsupported flag permanently', async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = gmailFlagMutationAdapter({ api: API, modify });
    await expect(adapter.perform({ ...payload, flag: '\\Answered' }, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'permanent', code: 'OPERATION_FORBIDDEN' });
    expect(modify).not.toHaveBeenCalled();
  });
});

describe('the Gmail move mutation adapter', () => {
  const payload: GmailMailMovePayload = {
    providerMessageId: 'm1', addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'], intentAt: '2026-09-01T00:00:00.000Z',
  };

  it('is declared idempotent, because Gmail keeps the message identity', () => {
    const adapter = gmailMoveMutationAdapter({ api: API });
    expect(adapter.idempotent).toBe(true);
  });

  it('adds the destination and removes the mailbox being left in one call', async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = gmailMoveMutationAdapter({ api: API, modify });
    await expect(adapter.perform(payload, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed' });
    expect(modify).toHaveBeenCalledWith(API, 'm1', ['Label_1'], ['INBOX']);
  });
});

describe('the Gmail label create adapter', () => {
  it('is not idempotent: a duplicate name is a 409 that cannot be told from an earlier attempt', () => {
    expect(gmailLabelCreateAdapter({ api: API }).idempotent).toBe(false);
  });

  it('parks a create that answered without an id rather than claiming success', async () => {
    const adapter = gmailLabelCreateAdapter({ api: API, create: vi.fn(async () => null) });
    await expect(adapter.perform({ name: 'Work', intentAt: 'now' }, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});

describe('the Gmail delete adapter', () => {
  it('is not idempotent: a second attempt answers 404, which is indistinguishable from another removal', () => {
    expect(gmailDeleteMutationAdapter({ api: API }).idempotent).toBe(false);
  });

  it('reports a committed removal', async () => {
    const adapter = gmailDeleteMutationAdapter({ api: API, remove: vi.fn(async () => undefined) });
    await expect(adapter.perform({ providerMessageId: 'm1', intentAt: 'now' }, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed' });
  });
});

describe('intent identity', () => {
  it('makes a repeated action a new operation while a retry reclaims its own row', () => {
    const first: GmailMailFlagPayload = { providerMessageId: 'm1', flag: '\\Seen', value: true, intentAt: '2026-09-01T00:00:00.000Z' };
    const second: GmailMailFlagPayload = { ...first, intentAt: '2026-09-01T00:01:00.000Z' };
    expect(gmailFlagIntent({ messageId: 'row-1', write: first })).toEqual(gmailFlagIntent({ messageId: 'row-1', write: first }));
    expect(gmailFlagIntent({ messageId: 'row-1', write: first }).idempotencyKey)
      .not.toBe(gmailFlagIntent({ messageId: 'row-1', write: second }).idempotencyKey);
  });

  it('keys a move on the label sets, ordered so the same move is one intent', () => {
    const base: GmailMailMovePayload = { providerMessageId: 'm1', addLabelIds: ['Label_1', 'Label_2'], removeLabelIds: ['INBOX'], intentAt: 'now' };
    const reordered: GmailMailMovePayload = { ...base, addLabelIds: ['Label_2', 'Label_1'] };
    expect(gmailMoveIntent(base).idempotencyKey).toBe(gmailMoveIntent(reordered).idempotencyKey);
    expect(gmailMoveIntent(base).idempotencyKey).not.toBe(gmailMoveIntent({ ...base, removeLabelIds: ['TRASH'] }).idempotencyKey);
  });

  it('keys a delete on the message and the action', () => {
    expect(gmailDeleteIntent({ providerMessageId: 'm1', intentAt: 'now' })).toEqual(gmailDeleteIntent({ providerMessageId: 'm1', intentAt: 'now' }));
  });
});
