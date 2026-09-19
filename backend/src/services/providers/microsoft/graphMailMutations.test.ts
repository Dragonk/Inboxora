import { describe, expect, it, vi } from 'vitest';
import { GraphApiError } from './graphApiClient.js';
import {
  classifyGraphMailMutationFailure,
  graphFlagIntent,
  graphFlagMutationAdapter,
  graphMessagePatchForFlag,
  graphMessageResource,
} from './graphMailMutations.js';
import type { GraphMailFlagPayload } from './graphMailMutations.js';

const API = { userId: 'user-1', connectionId: 'connection-1' };
const payload: GraphMailFlagPayload = {
  providerMessageId: 'AAMkAD-1', flag: '\\Seen', value: true, intentAt: '2026-03-04T09:00:00.000Z',
};

describe('mapping a local flag onto a Graph patch', () => {
  it('maps the two flags the application acts on', () => {
    expect(graphMessagePatchForFlag('\\Seen', true)).toEqual({ isRead: true });
    expect(graphMessagePatchForFlag('\\Seen', false)).toEqual({ isRead: false });
    expect(graphMessagePatchForFlag('\\Flagged', true)).toEqual({ flag: { flagStatus: 'flagged' } });
    expect(graphMessagePatchForFlag('\\Flagged', false)).toEqual({ flag: { flagStatus: 'notFlagged' } });
  });

  it('refuses a flag Graph has no equivalent for rather than guessing', () => {
    expect(graphMessagePatchForFlag('\\Answered', true)).toBeNull();
  });

  it('addresses the message by its provider id, escaped', () => {
    expect(graphMessageResource('AAMkAD/1+2')).toBe('/me/messages/AAMkAD%2F1%2B2');
  });
});

describe('classifying a Graph mutation failure', () => {
  it('keeps a retryable refusal retryable, with its delay', () => {
    const throttled = new GraphApiError({ code: 'RATE_LIMITED', message: 'slow down', status: 429, retryable: true, retryAfterSeconds: 12 });
    expect(classifyGraphMailMutationFailure(throttled)).toEqual({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 12 });
  });

  it('treats a missing message or a scope problem as permanent', () => {
    expect(classifyGraphMailMutationFailure(new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 })))
      .toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
    expect(classifyGraphMailMutationFailure(new GraphApiError({ code: 'INSUFFICIENT_SCOPES', message: 'no', status: 403 })))
      .toEqual({ status: 'permanent', code: 'INSUFFICIENT_SCOPES' });
  });

  it('treats a thrown request as an unknown outcome, never a retry', () => {
    // A timeout cannot tell us whether the PATCH reached the server, so an
    // automatic retry could apply a mutation that already happened.
    expect(classifyGraphMailMutationFailure(new Error('The operation was aborted'))).toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});

describe('the identity of one flag intent', () => {
  it('is derived from the payload, so a retry reclaims its own journal row', () => {
    const first = graphFlagIntent({ messageId: 'msg-1', write: payload });
    const again = graphFlagIntent({ messageId: 'msg-1', write: payload });
    expect(again).toEqual(first);
    expect(first.idempotencyKey).toContain('\\Seen');
  });

  it('is new for a later click, so a re-asserted flag still reaches the provider', () => {
    const later = graphFlagIntent({ messageId: 'msg-1', write: { ...payload, intentAt: '2026-03-04T10:00:00.000Z' } });
    expect(later.idempotencyKey).not.toBe(graphFlagIntent({ messageId: 'msg-1', write: payload }).idempotencyKey);
  });

  it('changes its payload hash when the intended value changes', () => {
    expect(graphFlagIntent({ messageId: 'msg-1', write: { ...payload, value: false } }).payloadHash)
      .not.toBe(graphFlagIntent({ messageId: 'msg-1', write: payload }).payloadHash);
  });
});

describe('the Graph flag adapter on the mutation layer', () => {
  it('is idempotent, because it sets a state rather than applying a delta', () => {
    expect(graphFlagMutationAdapter({ api: API }).idempotent).toBe(true);
    expect(graphFlagMutationAdapter({ api: API }).resourceType).toBe('message');
  });

  it('patches the message and reports a committed outcome', async () => {
    const patch = vi.fn(async () => null);
    const adapter = graphFlagMutationAdapter({ api: API, patch: patch as never });
    await expect(adapter.perform(payload, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'committed' });
    expect(patch).toHaveBeenCalledWith(API, '/me/messages/AAMkAD-1', { isRead: true });
  });

  it('reports a permanent refusal for an unsupported flag without calling Graph', async () => {
    const patch = vi.fn(async () => null);
    const adapter = graphFlagMutationAdapter({ api: API, patch: patch as never });
    await expect(adapter.perform({ ...payload, flag: '\\Answered' }, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'permanent', code: 'OPERATION_FORBIDDEN' });
    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces a Graph refusal as the shared outcome', async () => {
    const patch = vi.fn(async () => { throw new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 }); });
    const adapter = graphFlagMutationAdapter({ api: API, patch: patch as never });
    await expect(adapter.perform(payload, { operationId: 'op-1', signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
  });
});
