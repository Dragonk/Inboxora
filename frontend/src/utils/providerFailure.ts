/**
 * Turn a recorded provider failure code into something a user can act on.
 *
 * The recorded code is precise but internal: "MISSING_SCOPE" tells an operator what
 * to fix and tells everybody else nothing. The codes below are the ones with a real
 * user action behind them; anything else keeps the raw code, because inventing a
 * friendly sentence for a fault we do not understand would be worse than showing it.
 *
 * The keys are written out literally so the locale check can see them, and they live
 * under a provider-agnostic namespace because contacts and calendars share them.
 */
export type ProviderFailureKey =
  | 'providers.syncFailedAuth'
  | 'providers.syncFailedScopes'
  | 'providers.syncFailedRateLimited';

export function providerFailureKey(code: string | null | undefined): ProviderFailureKey | null {
  switch ((code ?? '').trim().toUpperCase()) {
    // The grant is gone or was refused: the only fix is to authorize again.
    // The last three are the provider's own wording for a consent that is gone; they
    // arrive as written by the provider, which is why the comparison upper-cases.
    case 'PROVIDER_AUTH_REQUIRED':
    case 'REAUTH_REQUIRED':
    case 'GRANT_NOT_FOUND':
    case 'TOKEN_REFRESH_FAILED':
    case 'INVALID_GRANT':
    case 'UNAUTHORIZED_CLIENT':
    case 'MISSING_REFRESH_TOKEN':
      return 'providers.syncFailedAuth';
    // The grant exists but is narrower than the feature needs.
    case 'INSUFFICIENT_SCOPES':
      return 'providers.syncFailedScopes';
    // Transient: the schedule retries on its own, so the message says so.
    case 'RATE_LIMITED':
    case 'UPSTREAM_UNAVAILABLE':
      return 'providers.syncFailedRateLimited';
    default:
      return null;
  }
}
