import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { decrypt, encrypt } from './encryption.js';

/**
 * Server-side OAuth authorization flows (P04, plan §6.1/§6.3).
 *
 * The state lives in `oauth_authorization_flows`, keyed by a hash of a one-time
 * state value, so a session can hold several parallel flows, a restart does not
 * lose a pending flow, and a database read cannot be replayed as a callback.
 * PKCE S256 is used for the browser flow; the verifier is encrypted at rest and
 * never returned to the browser.
 *
 * Google device authorization is deliberately absent: the limited-input device
 * flow does not allow the Gmail/Calendar/People scopes this integration needs
 * (plan §6.6), so only the web authorization-code flow is implemented here.
 */

export type OAuthProvider = 'microsoft' | 'google';
export type AuthorizationPurpose = 'new_account' | 'mail_migration' | 'calendar_enable' | 'contacts_enable';
export type RequestedAccess = 'source' | 'read_only';
export type AuthorizationFlowStatus = 'pending' | 'exchanging' | 'completed' | 'failed' | 'expired' | 'cancelled';

export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
/** Google access tokens are valid across its APIs; the audience names the API family. */
export const GOOGLE_GRANT_AUDIENCE = 'https://www.googleapis.com/';
export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** Microsoft Graph is the resource; the grant audience is the Graph origin. */
export const MICROSOFT_GRANT_AUDIENCE = 'https://graph.microsoft.com/';
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com';

const GOOGLE_AUTH_BASE = 'https://www.googleapis.com/auth/';
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

const DEFAULT_FLOW_TTL_SECONDS = 600;

export class ProviderAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderAuthError';
    this.code = code;
  }
}

/** The scopes one purpose asks for; independent features never imply one another. */
export function googleScopesForPurpose(purpose: AuthorizationPurpose, access: RequestedAccess = 'source'): string[] {
  const scopes = new Set<string>(GOOGLE_IDENTITY_SCOPES);
  switch (purpose) {
    case 'new_account':
    case 'mail_migration':
      // Mail only: adding a mailbox must not silently enable calendars/contacts (AU01).
      scopes.add(`${GOOGLE_AUTH_BASE}gmail.modify`);
      break;
    case 'calendar_enable':
      scopes.add(`${GOOGLE_AUTH_BASE}calendar.calendarlist.readonly`);
      scopes.add(`${GOOGLE_AUTH_BASE}${access === 'read_only' ? 'calendar.events.readonly' : 'calendar.events'}`);
      break;
    case 'contacts_enable':
      scopes.add(`${GOOGLE_AUTH_BASE}${access === 'read_only' ? 'contacts.readonly' : 'contacts'}`);
      break;
  }
  return [...scopes].sort();
}

/** PKCE S256 verifier/challenge pair. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function stateHashOf(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * A stable fingerprint of the provider configuration that started a flow. A
 * callback is only completed against the same configuration, so rotating the
 * Client ID cannot graft an old flow onto a new client.
 */
export function providerConfigRevision(config: GoogleConfig): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([config.clientId, config.redirectUri]))
    .digest('hex')
    .slice(0, 32);
}

export function isGoogleConfigured(config: Partial<GoogleConfig>): config is GoogleConfig {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

/** The effective Google client configuration (the admin UI/DB values land in env). */
export function googleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  return {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: env.GOOGLE_REDIRECT_URI || '',
  };
}

export interface MicrosoftConfig {
  clientId: string;
  /** Empty for a public client, which is how the device flow is registered. */
  clientSecret: string;
  redirectUri: string;
  tenantId: string;
}

/**
 * A tenant identifier is interpolated into the token URL path, so anything that
 * could change the target host or path is rejected rather than sent.
 */
function safeTenantId(value: unknown): string {
  const tenant = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9.-]+$/.test(tenant) ? tenant : 'common';
}

/** The effective Microsoft client configuration (MS_* environment variables). */
export function microsoftConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MicrosoftConfig {
  return {
    clientId: env.MS_CLIENT_ID || '',
    clientSecret: env.MS_CLIENT_SECRET || '',
    redirectUri: env.MS_REDIRECT_URI || '',
    tenantId: safeTenantId(env.MS_TENANT_ID),
  };
}

/**
 * Only a client id is required: the device flow is a public client and needs
 * neither a secret nor a redirect URI, so token refresh must not be gated on them.
 */
export function isMicrosoftConfigured(config: Partial<MicrosoftConfig>): config is MicrosoftConfig {
  return Boolean(config.clientId);
}

/**
 * Whether the **browser** authorization flow can actually run. It needs a confidential
 * client, so a secret and the exact redirect URI are required — use this wherever a
 * "connect an account" action is offered, because a status that only means "a client id
 * exists" would invite the user into a flow that fails at the provider.
 */
export function isMicrosoftBrowserFlowReady(config: Partial<MicrosoftConfig>): config is MicrosoftConfig {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

/** The v2.0 token endpoint for a tenant (`common` when none is configured). */
export function microsoftTokenEndpoint(tenantId?: string | null): string {
  return `${MICROSOFT_ISSUER}/${safeTenantId(tenantId)}/oauth2/v2.0/token`;
}

export interface CreateAuthorizationFlowInput {
  userId: string;
  provider: OAuthProvider;
  purpose: AuthorizationPurpose;
  targetAccountId?: string | null;
  scopes: readonly string[];
  returnRoute?: string | null;
  configRevision?: string | null;
  authFlow?: 'browser' | 'device_code';
  ttlSeconds?: number;
}

export interface CreatedAuthorizationFlow {
  flowId: string;
  /** Plaintext one-time state; only its hash is stored. */
  state: string;
  nonce: string;
  codeChallenge: string;
  expiresAt: Date;
}

/** Persist a new pending flow. The caller supplies the transaction. */
export async function createAuthorizationFlow(client: PoolClient, input: CreateAuthorizationFlowInput): Promise<CreatedAuthorizationFlow> {
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const { verifier, challenge } = createPkcePair();
  const ttlSeconds = Number.isFinite(input.ttlSeconds) && Number(input.ttlSeconds) > 0
    ? Math.floor(Number(input.ttlSeconds))
    : DEFAULT_FLOW_TTL_SECONDS;
  const result = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO oauth_authorization_flows
       (user_id, provider, purpose, target_account_id, state_hash, code_verifier_enc, nonce,
        requested_scopes, return_route, config_revision, auth_flow, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending', NOW() + make_interval(secs => $12))
     RETURNING id, expires_at`,
    [
      input.userId, input.provider, input.purpose, input.targetAccountId ?? null,
      stateHashOf(state), encrypt(verifier), nonce, [...input.scopes],
      input.returnRoute ?? null, input.configRevision ?? null, input.authFlow ?? 'browser', ttlSeconds,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new ProviderAuthError('FLOW_NOT_STORED', 'Could not store the authorization flow');
  return { flowId: row.id, state, nonce, codeChallenge: challenge, expiresAt: row.expires_at };
}

export interface TakenAuthorizationFlow {
  id: string;
  userId: string;
  provider: OAuthProvider;
  purpose: AuthorizationPurpose;
  targetAccountId: string | null;
  codeVerifier: string | null;
  nonce: string | null;
  requestedScopes: string[];
  returnRoute: string | null;
  configRevision: string | null;
}

/**
 * Consume a flow by its state. The status moves to `exchanging` in the same
 * statement that selects it, so a replayed callback finds nothing: single use is
 * enforced by the database, not by a check-then-write race.
 */
export async function takeAuthorizationFlow(client: PoolClient, input: {
  state: string;
  provider: OAuthProvider;
}): Promise<TakenAuthorizationFlow | null> {
  const result = await client.query<{
    id: string; user_id: string; provider: OAuthProvider; purpose: AuthorizationPurpose;
    target_account_id: string | null; code_verifier_enc: string | null; nonce: string | null;
    requested_scopes: string[] | null; return_route: string | null; config_revision: string | null;
  }>(
    `UPDATE oauth_authorization_flows
        SET status = 'exchanging'
      WHERE state_hash = $1 AND provider = $2 AND status = 'pending' AND expires_at > NOW()
      RETURNING id, user_id, provider, purpose, target_account_id, code_verifier_enc, nonce,
                requested_scopes, return_route, config_revision`,
    [stateHashOf(input.state), input.provider],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    purpose: row.purpose,
    targetAccountId: row.target_account_id,
    codeVerifier: row.code_verifier_enc ? decrypt(row.code_verifier_enc) : null,
    nonce: row.nonce,
    requestedScopes: row.requested_scopes ?? [],
    returnRoute: row.return_route,
    configRevision: row.config_revision,
  };
}

/** Terminal transition for a taken flow. Idempotent for an already-finished flow. */
export async function finishAuthorizationFlow(client: PoolClient, input: {
  flowId: string;
  status: Exclude<AuthorizationFlowStatus, 'pending'>;
  errorCode?: string | null;
}): Promise<boolean> {
  const result = await client.query(
    `UPDATE oauth_authorization_flows
        SET status = $2, error_code = $3, completed_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'exchanging')
      RETURNING id`,
    [input.flowId, input.status, input.errorCode ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Expire stale pending flows (maintenance; keeps the table bounded). */
export async function expireStaleFlows(client: PoolClient): Promise<number> {
  const result = await client.query(
    `UPDATE oauth_authorization_flows
        SET status = 'expired', completed_at = NOW()
      WHERE status = 'pending' AND expires_at <= NOW()`,
  );
  return result.rowCount ?? result.rows.length;
}

export function googleAuthorizeUrl(input: {
  config: GoogleConfig;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  nonce?: string | null;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...input.scopes].join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Offline access is what yields a refresh token; incremental consent keeps the
  // scopes of a previously granted feature instead of replacing them.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  if (input.nonce) url.searchParams.set('nonce', input.nonce);
  return url.toString();
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ExchangedGoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  idToken: string | null;
}

/**
 * Exchange an authorization code. A provider error is mapped to a typed
 * `ProviderAuthError`; `invalid_grant` is the revoked/expired signal callers
 * must not retry in a loop.
 */
export async function exchangeGoogleAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
}): Promise<ExchangedGoogleTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
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
    id_token?: string; error?: string; error_description?: string;
  };
  if (!response.ok || payload.error) {
    throw new ProviderAuthError(payload.error || 'TOKEN_EXCHANGE_FAILED', payload.error_description || 'Google token exchange failed');
  }
  if (!payload.access_token) throw new ProviderAuthError('TOKEN_EXCHANGE_FAILED', 'Google token response has no access token');
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  return {
    accessToken: payload.access_token,
    // A response without a refresh token must not erase a stored one; the caller
    // applies that rule on write (plan §6.3).
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    idToken: payload.id_token ?? null,
  };
}

export interface GoogleIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

/** Resolve the signed-in Google account from the access token (OIDC userinfo). */
export async function fetchGoogleIdentity(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleIdentity> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (caught) {
    throw new ProviderAuthError('USERINFO_UNAVAILABLE', caught instanceof Error ? caught.message : 'Google userinfo endpoint unreachable');
  }
  if (!response.ok) throw new ProviderAuthError('USERINFO_FAILED', `Google userinfo returned ${response.status}`);
  const payload = await response.json().catch(() => ({})) as {
    sub?: string; email?: string; email_verified?: boolean;
  };
  if (!payload.sub) throw new ProviderAuthError('IDENTITY_MISSING_SUBJECT', 'Google userinfo has no subject');
  return { subject: payload.sub, email: payload.email ?? null, emailVerified: payload.email_verified === true };
}

const MICROSOFT_IDENTITY_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const GRAPH_SCOPE_BASE = 'https://graph.microsoft.com/';

/**
 * The Graph scopes one purpose asks for. Features never imply one another: asking
 * for calendars must not silently grant the mailbox. `User.Read` accompanies every
 * purpose because identifying the account we just authorized needs it; it is the
 * lowest-privilege Graph scope and grants no data access on its own.
 */
export function microsoftScopesForPurpose(purpose: AuthorizationPurpose, access: RequestedAccess = 'source'): string[] {
  const scopes = new Set<string>([...MICROSOFT_IDENTITY_SCOPES, `${GRAPH_SCOPE_BASE}User.Read`]);
  const suffix = access === 'read_only' ? 'Read' : 'ReadWrite';
  switch (purpose) {
    case 'new_account':
    case 'mail_migration':
      scopes.add(`${GRAPH_SCOPE_BASE}Mail.ReadWrite`);
      scopes.add(`${GRAPH_SCOPE_BASE}Mail.Send`);
      break;
    case 'calendar_enable':
      scopes.add(`${GRAPH_SCOPE_BASE}Calendars.${suffix}`);
      break;
    case 'contacts_enable':
      scopes.add(`${GRAPH_SCOPE_BASE}Contacts.${suffix}`);
      break;
  }
  return [...scopes].sort();
}

export function microsoftAuthorizeUrl(input: {
  config: MicrosoftConfig;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  nonce?: string | null;
}): string {
  const url = new URL(`${MICROSOFT_ISSUER}/${safeTenantId(input.config.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', [...input.scopes].join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Pick the account explicitly instead of silently reusing the browser session,
  // so connecting the wrong mailbox is a visible choice, not an accident.
  url.searchParams.set('prompt', 'select_account');
  if (input.nonce) url.searchParams.set('nonce', input.nonce);
  return url.toString();
}

export interface ExchangedMicrosoftTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  idToken: string | null;
}

/** Exchange an authorization code for Graph tokens. */
export async function exchangeMicrosoftAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  config: MicrosoftConfig;
  fetchImpl?: FetchLike;
}): Promise<ExchangedMicrosoftTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
  });
  // A public client (the device flow) has no secret and sends none.
  if (input.config.clientSecret) body.set('client_secret', input.config.clientSecret);

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
    id_token?: string; error?: string; error_description?: string;
  };
  if (!response.ok || payload.error) {
    throw new ProviderAuthError(payload.error || 'TOKEN_EXCHANGE_FAILED', payload.error_description || 'Microsoft token exchange failed');
  }
  if (!payload.access_token) throw new ProviderAuthError('TOKEN_EXCHANGE_FAILED', 'Microsoft token response has no access token');
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    idToken: payload.id_token ?? null,
  };
}

export const MICROSOFT_GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';

export interface MicrosoftIdentity {
  subject: string;
  email: string | null;
  /**
   * Identity is read from Graph with the token we just received server-to-server
   * from Microsoft over TLS, bound to our client id and redirect URI. Nothing here
   * is supplied by the browser, so the identity cannot be forged by the caller.
   */
  displayName: string | null;
}

/** Resolve the signed-in Microsoft account from the Graph access token. */
export async function fetchMicrosoftIdentity(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<MicrosoftIdentity> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${MICROSOFT_GRAPH_ME_ENDPOINT}?$select=id,userPrincipalName,mail,displayName`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (caught) {
    throw new ProviderAuthError('USERINFO_UNAVAILABLE', caught instanceof Error ? caught.message : 'Microsoft Graph /me unreachable');
  }
  if (!response.ok) throw new ProviderAuthError('USERINFO_FAILED', `Microsoft Graph /me returned ${response.status}`);
  const payload = await response.json().catch(() => ({})) as {
    id?: string; userPrincipalName?: string; mail?: string; displayName?: string;
  };
  if (!payload.id) throw new ProviderAuthError('IDENTITY_MISSING_SUBJECT', 'Microsoft Graph /me has no id');
  return {
    subject: payload.id,
    // `mail` is absent for some account types; the UPN is the address to show.
    email: payload.mail ?? payload.userPrincipalName ?? null,
    displayName: payload.displayName ?? null,
  };
}

/**
 * Find or create the identity connection for a verified grant. Identity is
 * issuer + subject, never the e-mail address, so a renamed or aliased account
 * does not duplicate the connection.
 */
export async function upsertProviderConnection(client: PoolClient, input: {
  userId: string;
  provider: OAuthProvider;
  issuer: string;
  subject: string;
  tenantId?: string | null;
  providerUserId?: string | null;
  clientConfigId?: string | null;
}): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM provider_connections
      WHERE user_id = $1 AND provider = $2 AND issuer = $3 AND subject = $4
      FOR UPDATE`,
    [input.userId, input.provider, input.issuer, input.subject],
  );
  const found = existing.rows[0];
  if (found) {
    await client.query(
      `UPDATE provider_connections
          SET tenant_id = COALESCE($2, tenant_id),
              provider_user_id = COALESCE($3, provider_user_id),
              client_config_id = COALESCE($4, client_config_id),
              identity_verified_at = NOW(), status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [found.id, input.tenantId ?? null, input.providerUserId ?? null, input.clientConfigId ?? null],
    );
    return found.id;
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO provider_connections
       (user_id, provider, issuer, subject, tenant_id, provider_user_id, client_config_id, identity_verified_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'active')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.userId, input.provider, input.issuer, input.subject, input.tenantId ?? null, input.providerUserId ?? null, input.clientConfigId ?? null],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const raced = await client.query<{ id: string }>(
    `SELECT id FROM provider_connections WHERE user_id = $1 AND provider = $2 AND issuer = $3 AND subject = $4`,
    [input.userId, input.provider, input.issuer, input.subject],
  );
  const row = raced.rows[0];
  if (!row) throw new ProviderAuthError('CONNECTION_NOT_STORED', 'Could not store the provider connection');
  return row.id;
}

export interface StoreGrantInput {
  connectionId: string;
  audience: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  scopes: readonly string[];
  authFlow?: 'browser' | 'device_code';
  clientAuthMethod?: 'confidential' | 'public';
  clientConfigId?: string | null;
  clientIdAtIssue?: string | null;
}

/**
 * Store or refresh one grant. The critical invariant is that a response without a
 * refresh token keeps the stored one (COALESCE), and that every write bumps the
 * grant generation so a concurrent refresher cannot overwrite a newer token.
 */
export async function storeOAuthGrant(client: PoolClient, input: StoreGrantInput): Promise<{ id: string; generation: number }> {
  const result = await client.query<{ id: string; generation: string | number }>(
    `INSERT INTO oauth_grants
       (connection_id, audience, access_token_encrypted, refresh_token_encrypted, expires_at, scopes,
        auth_flow, client_auth_method, client_config_id, client_id_at_issue, generation, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'active')
     ON CONFLICT (connection_id, audience) DO UPDATE SET
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, oauth_grants.refresh_token_encrypted),
       expires_at = EXCLUDED.expires_at,
       scopes = EXCLUDED.scopes,
       auth_flow = EXCLUDED.auth_flow,
       client_auth_method = EXCLUDED.client_auth_method,
       client_config_id = EXCLUDED.client_config_id,
       client_id_at_issue = EXCLUDED.client_id_at_issue,
       generation = oauth_grants.generation + 1,
       status = 'active', reauth_reason = NULL, updated_at = NOW()
     RETURNING id, generation`,
    [
      input.connectionId, input.audience, encrypt(input.accessToken),
      input.refreshToken ? encrypt(input.refreshToken) : null,
      input.expiresAt, [...input.scopes], input.authFlow ?? 'browser',
      input.clientAuthMethod ?? 'confidential', input.clientConfigId ?? null, input.clientIdAtIssue ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new ProviderAuthError('GRANT_NOT_STORED', 'Could not store the OAuth grant');
  return { id: row.id, generation: Number(row.generation) };
}
