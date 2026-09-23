/**
 * One reducer for provider adapters, authorization callbacks and manual account sync.
 *
 * A page-limit/incomplete result is deliberately not success: its local projection is
 * only a prefix and must remain retryable.  Adapters may additionally report failed
 * collections without throwing, which is a partial result rather than completion.
 */
export type ProviderSyncOutcome = 'completed' | 'partial' | 'incomplete' | 'skipped_disabled';

export interface ProviderSyncResultLike {
  disabled?: boolean;
  incomplete?: boolean;
  incompleteCollections?: number;
  errors?: readonly { code?: string }[];
}

export interface ReducedProviderSyncResult {
  outcome: ProviderSyncOutcome;
  state: 'success' | 'partial' | 'incomplete' | 'skipped_disabled';
  synchronized: boolean;
  syncPending: boolean;
  errorCode: string | null;
}

export function reduceProviderSyncResult(result: ProviderSyncResultLike): ReducedProviderSyncResult {
  if (result.disabled) {
    return { outcome: 'skipped_disabled', state: 'skipped_disabled', synchronized: false, syncPending: false, errorCode: 'FEATURE_DISABLED' };
  }
  const firstError = result.errors?.find(error => typeof error.code === 'string' && error.code)?.code ?? null;
  if (firstError) {
    return { outcome: 'partial', state: 'partial', synchronized: false, syncPending: true, errorCode: firstError };
  }
  if (result.incomplete || (result.incompleteCollections ?? 0) > 0) {
    return { outcome: 'incomplete', state: 'incomplete', synchronized: false, syncPending: true, errorCode: 'PARTIAL_SYNC' };
  }
  return { outcome: 'completed', state: 'success', synchronized: true, syncPending: false, errorCode: null };
}
