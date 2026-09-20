/**
 * Turn a provider sync result into one sentence a user can act on.
 *
 * A count is not a diagnosis. "1 failure" leaves a user with nothing to do, while the domain code, the
 * provider's status and the scopes that are missing say whether to reconnect the account, wait for a rate
 * limit, or fix the request. The backend already answers with that detail; this is the one place that decides
 * how to say it, so Contacts and Calendar cannot drift apart in wording.
 *
 * The provider's own message is shown only as a last resort, and never a token or a raw payload: the states
 * behind `code` are the ones worth a sentence, and everything else is reported by code plus HTTP status.
 */

export interface ProviderSyncErrorLike {
  code?: string | null;
  message?: string | null;
  providerStatus?: number | null;
  missingScopes?: string[] | null;
  retryable?: boolean | null;
}

export interface ProviderSyncErrorSummary {
  /** The sentence for the first failure. */
  first: string;
  /** How many further failures the run had, for a "show details (N)" affordance. */
  more: number;
  /** Every failure, in the order the provider returned them, for a details list. */
  all: Array<{ code: string; message: string; status: number | null; missingScopes: string[]; retryable: boolean }>;
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * Codes that mean "reconnect the account", which is the only useful instruction for them.
 */
const AUTH_CODES = new Set([
  'PROVIDER_AUTH_REQUIRED', 'INVALID_GRANT', 'UNAUTHORIZED', 'AUTHORIZATION_REQUIRED',
  'INSUFFICIENT_SCOPES', 'ACCESS_DENIED', 'FORBIDDEN', 'REAUTH_REQUIRED', 'CONSENT_REQUIRED',
]);

export function normalizeProviderSyncErrors(errors: readonly (ProviderSyncErrorLike | null | undefined)[]): ProviderSyncErrorSummary['all'] {
  return errors.filter((error): error is ProviderSyncErrorLike => !!error).map(error => ({
    code: String(error.code ?? 'PROVIDER_ERROR'),
    message: String(error.message ?? ''),
    status: typeof error.providerStatus === 'number' ? error.providerStatus : null,
    missingScopes: Array.isArray(error.missingScopes) ? error.missingScopes.map(String) : [],
    retryable: error.retryable === true,
  }));
}

export function summariseProviderSyncErrors(input: {
  t: Translate;
  provider: 'google' | 'microsoft';
  feature: 'mail' | 'calendar' | 'contacts';
  errors: readonly (ProviderSyncErrorLike | null | undefined)[];
}): ProviderSyncErrorSummary | null {
  const all = normalizeProviderSyncErrors(input.errors);
  if (!all.length) return null;

  const [first, ...rest] = all;
  const providerName = input.provider === 'google' ? 'Google' : 'Microsoft';
  const service = input.t(`providers.syncError.service.${input.feature}`);
  const scopes = first.missingScopes.join(', ');

  let sentence: string;
  if (first.missingScopes.length) {
    // The most actionable case: name the scope and the button that grants it.
    sentence = input.t('providers.syncError.missingScopes', { provider: providerName, service, scopes });
  } else if (AUTH_CODES.has(first.code)) {
    sentence = input.t('providers.syncError.auth', { provider: providerName, service, code: first.code });
  } else if (first.status === 429) {
    sentence = input.t('providers.syncError.rateLimited', { provider: providerName, service });
  } else if (first.status !== null && first.status >= 500) {
    sentence = input.t('providers.syncError.providerDown', { provider: providerName, service, status: first.status });
  } else {
    sentence = input.t('providers.syncError.generic', {
      provider: providerName,
      service,
      code: first.code,
      ...(first.status !== null ? { status: first.status } : {}),
    });
  }

  return { first: sentence, more: rest.length, all };
}
