import { query } from './db.js';
import { readProviderFeatureAuthorization, type ProviderFeature } from './providerFeatureAuthorization.js';
import type { FeatureProvider } from './providerFeatureAuthorization.js';

/**
 * Why one connection's synchronisation failed, in a shape the interface can act on.
 *
 * A count is not a diagnosis: "1 failure" tells a user nothing they can do, while the provider's status, the
 * domain code and the scopes that are missing say whether to reconnect, wait, or fix the message. Everything
 * here is safe to render — a code, an HTTP status, a sanitised provider message and scope names. No token, no
 * secret, no raw provider payload is ever part of it.
 */
export interface ProviderSyncError {
  connectionId: string;
  accountId?: string | null;
  feature: ProviderFeature;
  code: string;
  providerStatus?: number | null;
  message: string;
  missingScopes?: string[];
  retryable?: boolean;
}

/** The HTTP status and retryability a provider error carries, whichever client raised it. */
function providerErrorDetails(caught: unknown): { code: string; message: string; status: number | null; retryable: boolean } {
  const candidate = caught as { code?: unknown; message?: unknown; status?: unknown; retryable?: unknown } | null;
  const code = typeof candidate?.code === 'string' && candidate.code ? candidate.code : 'PROVIDER_ERROR';
  const message = typeof candidate?.message === 'string' && candidate.message
    ? candidate.message
    : 'The provider request failed';
  const status = typeof candidate?.status === 'number' ? candidate.status : null;
  const retryable = typeof candidate?.retryable === 'boolean'
    ? candidate.retryable
    : status === 429 || (status !== null && status >= 500);
  return { code, message, status, retryable };
}

/** Codes that mean the authorization, not the request, is the problem. */
const AUTH_CODES = new Set([
  'PROVIDER_AUTH_REQUIRED', 'INVALID_GRANT', 'UNAUTHORIZED', 'AUTHORIZATION_REQUIRED',
  'INSUFFICIENT_SCOPES', 'ACCESS_DENIED', 'FORBIDDEN', 'REAUTH_REQUIRED', 'CONSENT_REQUIRED',
]);

/**
 * Build the error an interface can show, resolving what it can about the authorization.
 *
 * `missingScopes` is read from the same capability evaluator the account card uses, so a failure and the button
 * beside it cannot disagree about which scope is missing. A 401/403 that is not a scope problem still reports
 * the provider's own code and message rather than being flattened into one.
 */
export async function describeProviderSyncFailure(input: {
  userId: string;
  connectionId: string;
  provider: FeatureProvider;
  feature: ProviderFeature;
  caught: unknown;
  accountId?: string | null;
}): Promise<ProviderSyncError> {
  const details = providerErrorDetails(input.caught);
  const authProblem = AUTH_CODES.has(details.code) || details.status === 401 || details.status === 403;
  const authorization = authProblem
    ? await readProviderFeatureAuthorization({
        connectionId: input.connectionId,
        provider: input.provider,
        feature: input.feature,
      }).catch(() => null)
    : null;
  const missingScopes = authorization && authorization.missingScopes.length ? authorization.missingScopes : undefined;

  return {
    connectionId: input.connectionId,
    accountId: input.accountId ?? await accountIdForConnection(input.connectionId),
    feature: input.feature,
    // A 401/403 with scopes missing is a scope problem, which is the actionable statement; without scopes it is
    // the provider refusing the token, and the provider's own code is the honest answer.
    code: authProblem && missingScopes ? 'PROVIDER_AUTH_REQUIRED' : details.code,
    providerStatus: details.status,
    message: details.message,
    ...(missingScopes ? { missingScopes } : {}),
    retryable: details.retryable,
  };
}

/**
 * Refuse a synchronisation the grant cannot authorize, before asking the provider.
 *
 * A request that is certain to fail with 403 costs a round trip, may count against a rate limit and produces a
 * vaguer error than the one this returns.
 */
export async function providerSyncPreflight(input: {
  userId: string;
  connectionId: string;
  provider: FeatureProvider;
  feature: ProviderFeature;
}): Promise<ProviderSyncError | null> {
  const authorization = await readProviderFeatureAuthorization({
    connectionId: input.connectionId,
    provider: input.provider,
    feature: input.feature,
  });
  if (authorization.authorized) return null;
  return {
    connectionId: input.connectionId,
    accountId: await accountIdForConnection(input.connectionId),
    feature: input.feature,
    code: 'PROVIDER_AUTH_REQUIRED',
    providerStatus: null,
    message: `The ${input.provider === 'google' ? 'Google' : 'Microsoft'} authorization is missing ${authorization.missingScopes.join(', ') || 'a required scope'}`,
    missingScopes: authorization.missingScopes,
    retryable: false,
  };
}

/** The mailbox a connection authorizes, matched on the verified identity the connection carries. */
export async function accountIdForConnection(connectionId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT a.id
       FROM email_accounts a
       JOIN provider_connections c ON lower(COALESCE(c.provider_user_id, '')) = lower(a.email_address)
      WHERE c.id = $1 AND a.user_id = c.user_id
      ORDER BY a.created_at ASC
      LIMIT 1`,
    [connectionId],
  );
  return result.rows[0]?.id ?? null;
}
