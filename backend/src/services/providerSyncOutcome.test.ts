import { describe, expect, it } from 'vitest';
import { reduceProviderSyncResult } from './providerSyncOutcome.js';

describe('reduceProviderSyncResult', () => {
  it('never reports an incomplete collection run as success', () => {
    expect(reduceProviderSyncResult({ incompleteCollections: 1 })).toMatchObject({
      outcome: 'incomplete', state: 'incomplete', synchronized: false, syncPending: true, errorCode: 'PARTIAL_SYNC',
    });
  });

  it('preserves a settled collection failure as partial, not success or an in-flight retry', () => {
    expect(reduceProviderSyncResult({ errors: [{ code: 'PROVIDER_API_DISABLED' }] })).toMatchObject({
      outcome: 'partial', state: 'partial', synchronized: false, syncPending: false, errorCode: 'PROVIDER_API_DISABLED',
    });
  });

  it('keeps an explicit scope refusal terminal and distinct from a partial collection failure', () => {
    expect(reduceProviderSyncResult({ errors: [{ code: 'INSUFFICIENT_SCOPES' }] })).toMatchObject({
      outcome: 'auth_required', state: 'error', synchronized: false, syncPending: false, errorCode: 'INSUFFICIENT_SCOPES',
    });
  });

  it('reports completion only after a complete error-free result', () => {
    expect(reduceProviderSyncResult({ incomplete: false, errors: [] })).toMatchObject({
      outcome: 'completed', state: 'success', synchronized: true, syncPending: false, errorCode: null,
    });
  });
});
