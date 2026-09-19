/**
 * How a provider answer becomes an HTTP response.
 *
 * Every provider write path (contacts, calendar events, and the DAV write-back client when it lands)
 * reports the same shared mutation statuses, so the mapping lives once rather than per adapter: a
 * `conflict` is the caller's stale copy, a `permanent` refusal is a fact the user can be told, an
 * `outcome_unknown` is deliberately **not** retried, and a `retryable`/`pending` answer says the provider
 * did not apply it so trying again is safe.
 */
export interface ProviderWriteFailure {
  status: number;
  error: string;
  code?: string;
  retryAfterSeconds?: number;
}

export function providerWriteFailure(result: { status: string; code?: string; retryAfterSeconds?: number }): ProviderWriteFailure {
  if (result.status === 'conflict') {
    return { status: 409, error: 'The provider has a newer version of this item. Reload and try again.', ...(result.code ? { code: result.code } : {}) };
  }
  if (result.status === 'permanent') {
    const notFound = result.code === 'RESOURCE_NOT_FOUND';
    return {
      status: notFound ? 404 : 403,
      error: notFound ? 'This item no longer exists at the provider' : 'The provider refused this change',
      ...(result.code ? { code: result.code } : {}),
    };
  }
  if (result.status === 'outcome_unknown') {
    return {
      status: 502,
      error: 'The provider did not confirm this change. It will not be retried automatically; reload before trying again.',
      code: 'MUTATION_OUTCOME_UNKNOWN',
    };
  }
  // `retryable` and `pending`: the provider did not apply it, so a retry is safe and is advertised.
  return {
    status: 503,
    error: 'The provider is temporarily unavailable. Please try again shortly.',
    ...(result.code ? { code: result.code } : {}),
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
  };
}
