import { describe, it, expect } from 'vitest';
import {
  STAGING_DRAFT_OPERATION_HEADER,
  canTransition,
  isTerminal,
  requiresReconciliation,
  stagingDraftOperationPayload,
  type StagingDraftState,
} from './stagingDraft.js';

// The lifecycle's job is to make two rules structural rather than remembered: an uncertain send is never
// retried automatically, and a staging draft is not a user draft.
describe('the send staging draft lifecycle', () => {
  it('walks the happy path from creating to sent', () => {
    expect(canTransition('creating', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'ready')).toBe(true);
    expect(canTransition('ready', 'sending')).toBe(true);
    expect(canTransition('sending', 'sent')).toBe(true);
  });

  it('makes a send whose outcome is unknown terminal, so nothing retries it', () => {
    expect(canTransition('sending', 'send_outcome_unknown')).toBe(true);
    expect(isTerminal('send_outcome_unknown')).toBe(true);
    for (const state of ['sending', 'ready', 'creating', 'uploading'] as StagingDraftState[]) {
      expect(canTransition('send_outcome_unknown', state)).toBe(false);
    }
    // A deliberate resend is a new intent with a new staging draft, not a transition.
    expect(canTransition('sent', 'sending')).toBe(false);
    expect(canTransition('cancelled', 'sending')).toBe(false);
  });

  it('separates a failed upload from a failed send, and lets only the upload be retried', () => {
    expect(canTransition('uploading', 'upload_failed')).toBe(true);
    expect(canTransition('upload_failed', 'uploading')).toBe(true);
    expect(requiresReconciliation('upload_failed')).toBe(true);
    expect(requiresReconciliation('send_outcome_unknown')).toBe(true);
    expect(requiresReconciliation('sending')).toBe(false);
  });

  it('allows cancelling before the message is handed over, and never after', () => {
    for (const state of ['creating', 'uploading', 'ready'] as StagingDraftState[]) {
      expect(canTransition(state, 'cancelled')).toBe(true);
    }
    expect(canTransition('sending', 'cancelled')).toBe(false);
    expect(canTransition('sent', 'cancelled')).toBe(false);
  });

  it('records the operation it belongs to in the journal payload, and marks it with an opaque header', () => {
    const payload = stagingDraftOperationPayload({
      state: 'uploading', intentId: 'intent-1', providerDraftId: 'AAMkAD-draft-1', operationId: 'op-1',
    });
    expect(payload.stagingDraft).toEqual({
      state: 'uploading', intentId: 'intent-1', providerDraftId: 'AAMkAD-draft-1', operationId: 'op-1',
    });
    // The header carries the operation id and nothing that could be a secret.
    expect(payload.internetMessageHeaders).toEqual([{ name: STAGING_DRAFT_OPERATION_HEADER, value: 'op-1' }]);
  });

  it('omits the header when no operation has been claimed yet', () => {
    const payload = stagingDraftOperationPayload({ state: 'creating', intentId: 'intent-1', providerDraftId: null, operationId: null });
    expect(payload.internetMessageHeaders).toEqual([]);
  });
});
