/**
 * One reducer for provider adapters, authorization callbacks and manual account sync.
 *
 * A page-limit/incomplete result is deliberately not success: its local projection is
 * only a prefix and must remain retryable.  Adapters may additionally report failed
 * collections without throwing, which is a partial result rather than completion.
 */
export type ProviderSyncOutcome = 'completed' | 'partial' | 'incomplete' | 'skipped_disabled' | 'auth_required' | 'failed';

export interface ProviderSyncResultLike {
  disabled?: boolean;
  incomplete?: boolean;
  incompleteCollections?: number;
  errors?: readonly { code?: string }[];
}

export interface ReducedProviderSyncResult {
  outcome: ProviderSyncOutcome;
  state: 'success' | 'partial' | 'incomplete' | 'skipped_disabled' | 'error';
  synchronized: boolean;
  syncPending: boolean;
  errorCode: string | null;
}

const AUTHORIZATION_ERROR_CODES = new Set([
  'INSUFFICIENT_SCOPES', 'PROVIDER_AUTH_REQUIRED', 'INVALID_GRANT', 'UNAUTHORIZED',
  'AUTHORIZATION_REQUIRED', 'REAUTH_REQUIRED', 'CONSENT_REQUIRED',
]);

export function reduceProviderSyncResult(result: ProviderSyncResultLike): ReducedProviderSyncResult {
  if (result.disabled) {
    return { outcome: 'skipped_disabled', state: 'skipped_disabled', synchronized: false, syncPending: false, errorCode: 'FEATURE_DISABLED' };
  }
  const firstError = result.errors?.find(error => typeof error.code === 'string' && error.code)?.code ?? null;
  if (firstError) {
    // An explicit authorization refusal cannot make progress until consent changes. It is terminal for this run,
    // unlike a page-limited run, and must lead to an authorization action rather than an automatic retry.
    if (AUTHORIZATION_ERROR_CODES.has(firstError)) {
      return { outcome: 'auth_required', state: 'error', synchronized: false, syncPending: false, errorCode: firstError };
    }
    // One failed collection is a truthful partial result. The successful collections remain visible, but the
    // run is settled; only a new user/scheduler retry should start another attempt.
    return { outcome: 'partial', state: 'partial', synchronized: false, syncPending: false, errorCode: firstError };
  }
  if (result.incomplete || (result.incompleteCollections ?? 0) > 0) {
    return { outcome: 'incomplete', state: 'incomplete', synchronized: false, syncPending: true, errorCode: 'PARTIAL_SYNC' };
  }
  return { outcome: 'completed', state: 'success', synchronized: true, syncPending: false, errorCode: null };
}
