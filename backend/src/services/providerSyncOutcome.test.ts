import { describe, expect, it } from 'vitest';
import { reduceProviderSyncResult } from './providerSyncOutcome.js';

describe('reduceProviderSyncResult', () => {
  it('never reports an incomplete collection run as success', () => {
    expect(reduceProviderSyncResult({ incompleteCollections: 1 })).toMatchObject({
      outcome: 'incomplete', state: 'incomplete', synchronized: false, syncPending: true, errorCode: 'PARTIAL_SYNC',
    });
  });

  it('preserves collection failures as partial and retryable', () => {
    expect(reduceProviderSyncResult({ errors: [{ code: 'PROVIDER_API_DISABLED' }] })).toMatchObject({
      outcome: 'partial', state: 'partial', synchronized: false, syncPending: true, errorCode: 'PROVIDER_API_DISABLED',
    });
  });

  it('reports completion only after a complete error-free result', () => {
    expect(reduceProviderSyncResult({ incomplete: false, errors: [] })).toMatchObject({
      outcome: 'completed', state: 'success', synchronized: true, syncPending: false, errorCode: null,
    });
  });
});
