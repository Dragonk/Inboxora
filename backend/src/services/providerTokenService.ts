import { withTransaction } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_TOKEN_ENDPOINT,
  MICROSOFT_GRANT_AUDIENCE,
  ProviderAuthError,
  microsoftTokenEndpoint,
  type FetchLike,
  type GoogleConfig,
  type MicrosoftConfig,
} from './providerAuthService.js';
import type { PoolClient } from 'pg';

/**
 * Access-token supply for stored grants (P04, plan §6.4).
 *
 * Refresh is single-flight across the installation: a short lease names the one
 * worker allowed to call the provider, and every stored token bumps the grant
 * generation so the write is a compare-and-swap. A worker that lost the race
 * re-reads the newer token instead of overwriting it, and `invalid_grant` parks
 * the grant as `reauth_required` instead of retrying in a loop.
 *
 * The provider call always happens outside a database transaction.
 */

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_SKEW_SECONDS = 60;
const REFRESHABLE_STATUSES = new Set(['active']);

export interface GrantView {
  id: string;
  connectionId: string;
  provider: string;
  audience: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  authFlow: string;
  clientAuthMethod: string;
  clientConfigId: string | null;
  clientIdAtIssue: string | null;
  generation: number;
  status: string;
}

interface GrantRow {
  id: string; connection_id: string; provider: string; audience: string;
  access_token_encrypted: string | null; refresh_token_encrypted: string | null;
  expires_at: Date | null; scopes: string[] | null; auth_flow: string; client_auth_method: string;
  client_config_id: string | null; client_id_at_issue: string | null; generation: string | number; status: string;
}

function toGrantView(row: GrantRow): GrantView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    audience: row.audience,
    accessToken: row.access_token_encrypted ? decrypt(row.access_token_encrypted) : null,
    refreshToken: row.refresh_token_encrypted ? decrypt(row.refresh_token_encrypted) : null,
    expiresAt: row.expires_at,
    scopes: row.scopes ?? [],
    authFlow: row.auth_flow,
    clientAuthMethod: row.client_auth_method,
    clientConfigId: row.client_config_id,
    clientIdAtIssue: row.client_id_at_issue,
    generation: Number(row.generation),
    status: row.status,
  };
}

/** Read a grant, enforcing that the connection belongs to the user. */
export async function readGrantForUser(client: PoolClient, input: {
  userId: string;
  connectionId: string;
  audience?: string;
}): Promise<GrantView | null> {
  const result = await client.query<GrantRow>(
    `SELECT g.id, g.connection_id, c.provider, g.audience, g.access_token_encrypted,
            g.refresh_token_encrypted, g.expires_at, g.scopes, g.auth_flow, g.client_auth_method,
            g.client_config_id, g.client_id_at_issue, g.generation, g.status
       FROM oauth_grants g
       JOIN provider_connections c ON c.id = g.connection_id
      WHERE g.connection_id = $1 AND g.audience = $2 AND c.user_id = $3`,
    [input.connectionId, input.audience ?? GOOGLE_GRANT_AUDIENCE, input.userId],
  );
  const row = result.rows[0];
  return row ? toGrantView(row) : null;
}

/** Take the refresh lease. `null` means another worker holds an unexpired one. */
export async function acquireRefreshLease(client: PoolClient, input: {
  grantId: string;
  owner: string;
  leaseSeconds?: number;
}): Promise<{ generation: number } | null> {
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const result = await client.query<{ generation: string | number }>(
    `UPDATE oauth_grants
        SET refresh_lease_owner = $2,
            refresh_lease_expires_at = NOW() + make_interval(secs => $3),
            updated_at = NOW()
      WHERE id = $1 AND (refresh_lease_expires_at IS NULL OR refresh_lease_expires_at <= NOW())
      RETURNING generation`,
    [input.grantId, input.owner, leaseSeconds],
  );
  const row = result.rows[0];
  return row ? { generation: Number(row.generation) } : null;
}

export async function releaseRefreshLease(client: PoolClient, grantId: string): Promise<void> {
  await client.query(
    `UPDATE oauth_grants
        SET refresh_lease_expires_at = NULL, refresh_lease_owner = NULL, updated_at = NOW()
      WHERE id = $1`,
    [grantId],
  );
}

/**
 * Compare-and-swap store of a refreshed token. Returns null when a newer
 * generation exists, which means another writer already stored a token and this
 * result must not overwrite it.
 */
export async function storeRefreshedGrant(client: PoolClient, input: {
  grantId: string;
  expectedGeneration: number;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: readonly string[];
}): Promise<{ generation: number } | null> {
  const result = await client.query<{ generation: string | number }>(
    `UPDATE oauth_grants
        SET access_token_encrypted = $3,
            refresh_token_encrypted = COALESCE($4, refresh_token_encrypted),
            expires_at = $5,
            scopes = CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE scopes END,
            generation = generation + 1,
            status = 'active', reauth_reason = NULL,
            refresh_lease_expires_at = NULL, refresh_lease_owner = NULL,
            updated_at = NOW()
      WHERE id = $1 AND generation = $2
      RETURNING generation`,
    [input.grantId, input.expectedGeneration, encrypt(input.accessToken),
      input.refreshToken ? encrypt(input.refreshToken) : null, input.expiresAt, [...input.scopes]],
  );
  const row = result.rows[0];
  return row ? { generation: Number(row.generation) } : null;
}

/** Stop automatic refresh for a grant whose consent was revoked. */
export async function markGrantReauthRequired(client: PoolClient, input: {
  grantId: string;
  reason: string;
}): Promise<void> {
  await client.query(
    `UPDATE oauth_grants
        SET status = 'reauth_required', reauth_reason = $2,
            refresh_lease_expires_at = NULL, refresh_lease_owner = NULL, updated_at = NOW()
      WHERE id = $1`,
    [input.grantId, input.reason],
  );
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface RefreshedGoogleTokens extends RefreshedTokens {}

/** Exchange a refresh token. Provider errors are mapped, never swallowed. */
export async function exchangeGoogleRefreshToken(input: {
  refreshToken: string;
  /** The grant's consented scopes; Google infers them from the refresh token. */
  scopes?: readonly string[];
  config: GoogleConfig;
  fetchImpl?: FetchLike;
}): Promise<RefreshedGoogleTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    grant_type: 'refresh_token',
  });
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (caught) {
    throw new ProviderAuthError('TOKEN_ENDPOINT_UNAVAILABLE', caught instanceof Error ? caught.message : 'Google token endpoint unreachable');
  }
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
    error?: string; error_description?: string;
  };
  if (!response.ok || payload.error) {
    throw new ProviderAuthError(payload.error || 'TOKEN_REFRESH_FAILED', payload.error_description || 'Google token refresh failed');
  }
  if (!payload.access_token) throw new ProviderAuthError('TOKEN_REFRESH_FAILED', 'Google refresh response has no access token');
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  return {
    accessToken: payload.access_token,
    // An omitted refresh token keeps the stored one (applied on write).
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
  };
}

export interface AccessTokenResult {
  accessToken: string;
  expiresAt: Date;
  generation: number;
  refreshed: boolean;
  scopes: string[];
}

/** The token of a grant that is still valid beyond the clock-skew margin. */
function usableToken(grant: GrantView | null, now: Date, skewMs: number): Omit<AccessTokenResult, 'refreshed'> | null {
  if (!grant?.accessToken || !grant.expiresAt) return null;
  if (grant.expiresAt.getTime() <= now.getTime() + skewMs) return null;
  if (!REFRESHABLE_STATUSES.has(grant.status)) return null;
  return { accessToken: grant.accessToken, expiresAt: grant.expiresAt, generation: grant.generation, scopes: grant.scopes };
}

/** Provider-specific pieces of the shared refresh orchestration. */
interface ProviderTokenProfile<TConfig> {
  /** Names the provider in diagnostics only; never user-facing. */
  label: string;
  audience: string;
  exchange: (input: {
    refreshToken: string;
    scopes: readonly string[];
    config: TConfig;
    fetchImpl?: FetchLike;
  }) => Promise<RefreshedTokens>;
}

const GOOGLE_TOKEN_PROFILE: ProviderTokenProfile<GoogleConfig> = {
  label: 'Google',
  audience: GOOGLE_GRANT_AUDIENCE,
  exchange: (input) => exchangeGoogleRefreshToken(input),
};

const MICROSOFT_TOKEN_PROFILE: ProviderTokenProfile<MicrosoftConfig> = {
  label: 'Microsoft',
  audience: MICROSOFT_GRANT_AUDIENCE,
  exchange: (input) => exchangeMicrosoftRefreshToken(input),
};

/**
 * Return a usable access token for a stored grant, refreshing it only when needed.
 * Throws `ProviderAuthError` with `REAUTH_REQUIRED` when the user must reconnect,
 * and with `REFRESH_IN_PROGRESS` when another worker holds the lease (the caller
 * retries later rather than starting a second refresh).
 *
 * Both providers share this path on purpose: the lease, the generation
 * compare-and-swap and the re-auth parking are the parts that must not diverge.
 */
async function getProviderAccessToken<TConfig>(profile: ProviderTokenProfile<TConfig>, input: {
  userId: string;
  connectionId: string;
  audience?: string;
  config: TConfig;
  owner?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  skewSeconds?: number;
  leaseSeconds?: number;
}): Promise<AccessTokenResult> {
  const audience = input.audience ?? profile.audience;
  const now = input.now ?? new Date();
  const skewMs = (Number.isFinite(input.skewSeconds) ? Number(input.skewSeconds) : DEFAULT_SKEW_SECONDS) * 1000;

  const initial = await withTransaction(client => readGrantForUser(client, { userId: input.userId, connectionId: input.connectionId, audience }));
  if (!initial) throw new ProviderAuthError('GRANT_NOT_FOUND', `No stored ${profile.label} grant for this connection`);
  if (initial.status === 'reauth_required' || initial.status === 'revoked') {
    throw new ProviderAuthError('REAUTH_REQUIRED', `The ${profile.label} grant needs the user to authorize again`);
  }
  const current = usableToken(initial, now, skewMs);
  if (current) return { ...current, refreshed: false };
  if (!initial.refreshToken) {
    await withTransaction(client => markGrantReauthRequired(client, { grantId: initial.id, reason: 'MISSING_REFRESH_TOKEN' }));
    throw new ProviderAuthError('REAUTH_REQUIRED', `The stored ${profile.label} grant has no refresh token`);
  }

  const owner = input.owner ?? 'token-service';
  const lease = await withTransaction(client => acquireRefreshLease(client, {
    grantId: initial.id, owner, leaseSeconds: input.leaseSeconds,
  }));
  if (!lease) {
    // Another worker is refreshing; use its result if it has already landed.
    const concurrent = await withTransaction(client => readGrantForUser(client, { userId: input.userId, connectionId: input.connectionId, audience }));
    const landed = usableToken(concurrent, now, skewMs);
    if (landed) return { ...landed, refreshed: true };
    throw new ProviderAuthError('REFRESH_IN_PROGRESS', 'Another worker is refreshing this grant');
  }

  try {
    // Re-read the grant *under* the lease before calling the provider. A successful
    // store releases the lease, so a worker that read an expired token before another
    // worker stored a fresh one can still acquire the now-free lease. Without this check
    // it would refresh a second time with the token it read earlier — harmless where the
    // provider keeps its refresh token, but a real risk where it rotates it, because the
    // second exchange can invalidate the first worker's result.
    const guarded = await withTransaction(client => readGrantForUser(client, { userId: input.userId, connectionId: input.connectionId, audience }));
    const superseded = usableToken(guarded, now, skewMs);
    if (superseded) {
      await withTransaction(client => releaseRefreshLease(client, initial.id)).catch(() => {});
      return { ...superseded, refreshed: true };
    }
    const tokens = await profile.exchange({
      // The token read under the lease, not the one read before acquiring it.
      refreshToken: guarded?.refreshToken ?? initial.refreshToken,
      scopes: initial.scopes,
      config: input.config,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    const stored = await withTransaction(client => storeRefreshedGrant(client, {
      grantId: initial.id,
      expectedGeneration: lease.generation,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    }));
    if (!stored) {
      // A newer generation exists: use it rather than overwriting it.
      const newer = await withTransaction(client => readGrantForUser(client, { userId: input.userId, connectionId: input.connectionId, audience }));
      const superseding = usableToken(newer, now, skewMs);
      if (superseding) return { ...superseding, refreshed: true };
      throw new ProviderAuthError('REFRESH_RACE', 'A newer grant version exists; re-read before retrying');
    }
    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      generation: stored.generation,
      refreshed: true,
      scopes: tokens.scopes.length ? tokens.scopes : initial.scopes,
    };
  } catch (caught) {
    if (caught instanceof ProviderAuthError && (caught.code === 'invalid_grant' || caught.code === 'unauthorized_client')) {
      // The consent was revoked or the client changed: stop automatic refresh.
      await withTransaction(client => markGrantReauthRequired(client, { grantId: initial.id, reason: caught.code })).catch(() => {});
    } else {
      await withTransaction(client => releaseRefreshLease(client, initial.id)).catch(() => {});
    }
    throw caught;
  }
}

export async function getGoogleAccessToken(input: {
  userId: string;
  connectionId: string;
  audience?: string;
  config: GoogleConfig;
  owner?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  skewSeconds?: number;
  leaseSeconds?: number;
}): Promise<AccessTokenResult> {
  return getProviderAccessToken(GOOGLE_TOKEN_PROFILE, input);
}

export interface RefreshedMicrosoftTokens extends RefreshedTokens {}

/**
 * Exchange a Microsoft refresh token. Microsoft usually rotates it, so a returned
 * refresh token replaces the stored one; an omitted one keeps the stored value.
 * A public client (the device flow) has no secret and sends none.
 */
export async function exchangeMicrosoftRefreshToken(input: {
  refreshToken: string;
  scopes?: readonly string[];
  config: MicrosoftConfig;
  fetchImpl?: FetchLike;
}): Promise<RefreshedMicrosoftTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  });
  if (input.config.clientSecret) body.set('client_secret', input.config.clientSecret);
  if (input.scopes?.length) body.set('scope', [...input.scopes].join(' '));

  let response: Response;
  try {
    response = await fetchImpl(microsoftTokenEndpoint(input.config.tenantId), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (caught) {
    throw new ProviderAuthError('TOKEN_ENDPOINT_UNAVAILABLE', caught instanceof Error ? caught.message : 'Microsoft token endpoint unreachable');
  }
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
    error?: string; error_description?: string;
  };
  if (!response.ok || payload.error) {
    throw new ProviderAuthError(payload.error || 'TOKEN_REFRESH_FAILED', payload.error_description || 'Microsoft token refresh failed');
  }
  if (!payload.access_token) throw new ProviderAuthError('TOKEN_REFRESH_FAILED', 'Microsoft refresh response has no access token');
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
  };
}

export async function getMicrosoftAccessToken(input: {
  userId: string;
  connectionId: string;
  audience?: string;
  config: MicrosoftConfig;
  owner?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  skewSeconds?: number;
  leaseSeconds?: number;
}): Promise<AccessTokenResult> {
  return getProviderAccessToken(MICROSOFT_TOKEN_PROFILE, input);
}
