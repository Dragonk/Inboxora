import { randomBytes, createHash } from 'crypto';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { Router } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { PoolClient } from 'pg';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { query, pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, isEncrypted } from '../services/encryption.js';
import { imapManager } from '../index.js';
import { validateHost } from '../services/hostValidation.js';
import { logAuthEvent } from '../services/authEvents.js';
import { ensureUserDavResources } from '../services/userDavResources.js';
import { queryString } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';

interface OidcDiscoveryDocument {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
}

interface OidcTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Claims read from the verified id_token; unknown claims stay accessible by name. */
type OidcIdTokenClaims = {
  iss?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
  name?: string;
  [claim: string]: unknown;
};

/** Columns of oidc_providers read by this router. */
type OidcProviderRow = {
  id: string;
  slug: string;
  issuer_url: string;
  client_id: string;
  client_secret?: string | null;
  scopes?: string | null;
  allow_insecure?: boolean | null;
  rp_initiated_logout?: boolean | null;
  allowed_domains?: string | null;
  provisioning_mode?: string | null;
  require_email_verified?: boolean | null;
  admin_group_claim?: string | null;
  admin_group_value?: string | null;
  login_match_claim?: string | null;
  [column: string]: unknown;
};

interface EndSessionInput {
  providerId?: string | null;
  idToken?: string | null;
}

// In-memory OIDC discovery cache keyed by issuerUrl
/** The largest identity-provider response this route will hold in memory. */
const OIDC_RESPONSE_LIMIT_BYTES = 1_048_576;

const discoveryCache = new Map();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

// Node's HTTP request options expect a plain header record. undici (jose's customFetch
// path) passes a Headers instance, which the previous implementation forwarded as-is and
// node serialised to no headers; keep that behaviour and forward only plain records.
function toNodeHeaders(headers: RequestInit['headers']): Record<string, string | string[]> {
  if (!headers || Array.isArray(headers) || headers instanceof Headers) return {};
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = typeof value === 'string' ? value : [...value];
  }
  return out;
}

// Fetch that skips TLS certificate verification — only used when allow_insecure is set.
function makeInsecureFetch(signal?: AbortSignal): typeof fetch {
  return function insecureFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Promise<Response>((resolve, reject) => {
      const effectiveSignal = init.signal ?? signal;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const port = parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80);
      const reqFn = isHttps ? httpsRequest : httpRequest;
      const chunks: Buffer[] = [];
      // The identity provider's answers are small — a discovery document, a token, a JWKS — and this
      // accumulates them in memory, so it is bounded the way the DAV routes are. A response beyond
      // the cap is refused rather than buffered: a compromised or misconfigured provider must not be
      // able to exhaust the process, and nothing here needs a larger reply.
      let received = 0;
      const req = reqFn(
        { hostname: parsed.hostname, port, path: parsed.pathname + parsed.search, method: init.method ?? 'GET', headers: toNodeHeaders(init.headers), rejectUnauthorized: false },
        res => {
          res.on('data', (c: Buffer) => {
            received += c.length;
            if (received > OIDC_RESPONSE_LIMIT_BYTES) {
              res.destroy();
              reject(new Error('OIDC response is too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(new Response(text, { status: res.statusCode ?? 200 }));
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      if (effectiveSignal) effectiveSignal.addEventListener('abort', () => req.destroy(), { once: true });
      if (init.body) req.write(init.body);
      req.end();
    });
  };
}

async function getDiscovery(issuerUrl: string, allowInsecure: boolean | null | undefined = false) {
  const parsed = new URL(issuerUrl);
  if (!allowInsecure && parsed.protocol !== 'https:') throw new Error('OIDC issuer URL must use HTTPS');

  // Re-validate at runtime: the saved issuer may predate host validation,
  // or DNS may have changed since the record was saved.
  if (!allowInsecure) {
    const issuerHostErr = await validateHost(parsed.hostname);
    if (issuerHostErr) throw new Error(`OIDC issuer host rejected: ${issuerHostErr}`);
  }

  const cacheKey = `${issuerUrl}:${allowInsecure}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < DISCOVERY_TTL_MS) {
    return { doc: cached.doc, jwks: cached.jwks };
  }
  const wellKnown = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const signal = AbortSignal.timeout(10000);
  const fetchFn = allowInsecure ? makeInsecureFetch(signal) : fetch;
  const fetchOpts = allowInsecure ? {} : { signal };
  const res = await fetchFn(wellKnown, fetchOpts);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`OIDC discovery blocked (${res.status}): the server cannot reach ${wellKnown} — ensure the well-known endpoint is publicly accessible from the Inboxora server`);
    }
    throw new Error(`OIDC discovery failed for ${issuerUrl}: ${res.status}`);
  }
  const doc = (await res.json()) as OidcDiscoveryDocument;
  const normConfigured = issuerUrl.replace(/\/$/, '');
  const normDiscovered = (doc.issuer || '').replace(/\/$/, '');
  if (normDiscovered !== normConfigured) {
    throw new Error(`OIDC issuer mismatch: configured "${normConfigured}", got "${normDiscovered}"`);
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const url = doc[field];
    if (!url) throw new Error(`OIDC discovery missing required field: ${field}`);
    let endpointParsed;
    try { endpointParsed = new URL(url); } catch {
      throw new Error(`OIDC discovery returned invalid URL for ${field}: ${url}`);
    }
    if (!allowInsecure) {
      if (endpointParsed.protocol !== 'https:') {
        throw new Error(`OIDC discovery returned non-HTTPS ${field}: ${url}`);
      }
      const hostErr = await validateHost(endpointParsed.hostname);
      if (hostErr) throw new Error(`OIDC discovery ${field} points to a disallowed host: ${hostErr}`);
    }
  }
  const jwksUri = doc.jwks_uri;
  if (!jwksUri) throw new Error('OIDC discovery missing required field: jwks_uri');
  const jwksOptions = allowInsecure ? { [customFetch]: makeInsecureFetch() } : {};
  const jwks = createRemoteJWKSet(new URL(jwksUri), jwksOptions);
  discoveryCache.set(cacheKey, { doc, jwks, cachedAt: Date.now() });
  return { doc, jwks };
}

function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function getRedirectUri(provider: Pick<OidcProviderRow, 'slug'>) {
  return `${process.env.APP_URL}/auth/oidc/${provider.slug}/callback`;
}

// Returns true/false when admin_group_claim is configured, null when not configured.
// true  → user should be admin
// false → user should not be admin
// null  → feature not configured; leave is_admin unchanged
function resolveAdminFromClaim(payload: OidcIdTokenClaims, provider: Pick<OidcProviderRow, 'admin_group_claim' | 'admin_group_value'>) {
  if (!provider.admin_group_claim || !provider.admin_group_value) return null;
  const val = payload[provider.admin_group_claim];
  if (val === undefined) return false;
  if (Array.isArray(val)) return val.includes(provider.admin_group_value);
  if (typeof val === 'string') return val === provider.admin_group_value;
  return false;
}

// Resolve the value used to match an SSO login to an existing Inboxora account during the
// initial link (login_existing_only). The claim name is admin-configured (default 'email',
// the historical behavior) and read from the *verified* id_token; the result is always matched
// against users.username. An admin who selects a non-email claim (e.g. 'preferred_username' or
// Entra's 'upn') is trusting their IdP to make that claim unique and not user-editable — which
// is why 'email' stays the default and anything else is explicit opt-in. Returns a lowercased,
// trimmed string, or null when the claim is absent/blank/non-string (which the caller treats as
// "no matching account"). See issue #289. Never matches secondary email_accounts addresses —
// proving control of a mailbox a user added must not log you in as that user.
const DANGEROUS_CLAIM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function resolveLoginMatchValue(provider: Pick<OidcProviderRow, 'login_match_claim'> | null | undefined, payload: OidcIdTokenClaims | null | undefined, email: string | null | undefined) {
  const claim = (provider?.login_match_claim || 'email').trim() || 'email';
  // Never index the payload by an object-prototype key. `payload["__proto__"]` from JSON.parse is
  // a string own-property that would pass the typeof guard below; the others resolve to functions.
  // Belt-and-suspenders with admin.js validation, and it also protects any pre-existing bad row.
  if (claim !== 'email' && DANGEROUS_CLAIM_KEYS.has(claim)) return null;
  const raw = claim === 'email' ? email : payload?.[claim];
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

// Seed users.display_name from the OIDC 'name' (profile) claim on first association, but only
// when it is currently empty — never overwrite a value the user or admin set. Bounded to the
// column width (VARCHAR(100)). Best-effort nicety; requested in #289.
async function maybeBackfillDisplayName(client: PoolClient, userId: string, payload: OidcIdTokenClaims | null | undefined) {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  if (!name) return;
  await client.query(
    "UPDATE users SET display_name = $1 WHERE id = $2 AND (display_name IS NULL OR display_name = '')",
    [name.slice(0, 100), userId]
  );
}

// Record how the user signed in so logout can offer RP-initiated (end-session) logout.
// The raw id_token is kept for use as id_token_hint; the provider id lets logout look up
// its issuer and the rp_initiated_logout toggle. Both are cleared when the session is
// destroyed at logout.
function rememberOidcSession(req: ExpressRequest, providerId: string, idToken: string | undefined) {
  req.session.oidcProviderId = providerId;
  if (idToken) req.session.oidcIdToken = idToken;
}

// Build the OIDC RP-initiated logout (end-session) URL for a session that signed in via
// a provider with rp_initiated_logout enabled. Returns null when it does not apply — no
// provider on the session, the toggle is off, the provider is gone, discovery fails, or
// the issuer advertises no end_session_endpoint — so logout falls back to local-only.
// Never throws: logging out must always succeed locally regardless of the IdP.
export async function buildEndSessionUrl({ providerId, idToken }: EndSessionInput = {}) {
  if (!providerId) return null;
  try {
    const { rows } = await query<{ issuer_url: string; client_id: string; allow_insecure?: boolean | null; rp_initiated_logout?: boolean | null }>(
      'SELECT issuer_url, client_id, allow_insecure, rp_initiated_logout FROM oidc_providers WHERE id = $1',
      [providerId]
    );
    const provider = rows[0];
    if (!provider || !provider.rp_initiated_logout) return null;

    const { doc } = await getDiscovery(provider.issuer_url, provider.allow_insecure);
    if (!doc.end_session_endpoint) return null;

    const params = new URLSearchParams({ client_id: provider.client_id });
    if (idToken) params.set('id_token_hint', idToken);
    // post_logout_redirect_uri must be registered with the IdP; omit it when APP_URL is
    // unset (dev) so the request stays valid and the IdP shows its own logged-out page.
    if (process.env.APP_URL) params.set('post_logout_redirect_uri', `${process.env.APP_URL}/login`);

    return `${doc.end_session_endpoint}?${params}`;
  } catch (caught) {
    const err = toAppError(caught);
    console.error('buildEndSessionUrl failed:', err.message);
    return null;
  }
}

// ── Public API router (mounted at /api/auth/oidc) ─────────────────────────────

const oidcApiRouter = Router();

// List enabled providers — shown on login page, no auth required
oidcApiRouter.get('/providers', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, slug FROM oidc_providers WHERE enabled = true ORDER BY name ASC'
    );
    res.json({ providers: result.rows });
  } catch {
    res.status(500).json({ error: 'Failed to load providers' });
  }
});

// List identities linked to the current user
oidcApiRouter.get('/identities', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT ui.id, ui.issuer, ui.email, ui.created_at, ui.last_used_at,
              op.name AS provider_name, op.slug AS provider_slug
       FROM user_identities ui
       JOIN oidc_providers op ON op.id = ui.provider_id
       WHERE ui.user_id = $1
       ORDER BY ui.created_at ASC`,
      [req.session.userId]
    );
    res.json({ identities: result.rows });
  } catch {
    res.status(500).json({ error: 'Failed to load identities' });
  }
});

// Unlink an identity from the current user
oidcApiRouter.delete('/identities/:id', requireAuth, async (req, res) => {
  try {
    // Prevent removing the last login method when no password is set
    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const hasPassword = !!userResult.rows[0]?.password_hash;
    if (!hasPassword) {
      const countResult = await query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM user_identities WHERE user_id = $1',
        [req.session.userId]
      );
      if (parseInt(countResult.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot unlink your only login method. Set a password first.' });
      }
    }
    await query<{ id: string; issuer_url: string; client_id: string; scopes?: string | null; allow_insecure?: boolean | null; rp_initiated_logout?: boolean | null }>(
      'DELETE FROM user_identities WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to unlink identity' });
  }
});

export default oidcApiRouter;

// ── Browser router (mounted at /auth/oidc — no /api prefix) ──────────────────
// These routes produce browser redirects, not JSON responses.

export const oidcBrowserRouter = Router();

// Error redirect: login-flow errors go to /login?oidc_error= (shown on LoginPage);
// link-flow errors go to /?oidc_error= (shown as a toast inside MailApp).
function oidcError(res: ExpressResponse, action: string, message: string) {
  const base = action === 'link' ? '/' : '/login';
  return res.redirect(`${base}?oidc_error=${encodeURIComponent(message)}`);
}

// Step 1: redirect the browser to the OIDC provider's authorization endpoint
oidcBrowserRouter.get('/:slug/start', async (req, res) => {
  const { slug } = req.params;
  const isLink = req.query.action === 'link';
  const action = isLink ? 'link' : 'login';

  if (isLink && !req.session?.userId) {
    return oidcError(res, action, 'Not authenticated');
  }

  try {
    const provResult = await query<OidcProviderRow>(
      'SELECT * FROM oidc_providers WHERE slug = $1 AND enabled = true',
      [slug]
    );
    if (!provResult.rows.length) {
      return oidcError(res, action, 'SSO provider not found');
    }
    const provider = provResult.rows[0];
    const { doc } = await getDiscovery(provider.issuer_url, provider.allow_insecure);

    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const { verifier, challenge } = generatePKCE();

    req.session.oidcPending = {
      state,
      nonce,
      verifier,
      providerId: provider.id,
      action,
      linkUserId: isLink ? req.session.userId : undefined,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    const params = new URLSearchParams({
      client_id: provider.client_id,
      response_type: 'code',
      redirect_uri: getRedirectUri(provider),
      scope: provider.scopes || 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    // Save session before redirecting so the PKCE verifier and state nonce are
    // committed to the store before the provider redirects back with the code.
    await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch (caught) {
    const err = toAppError(caught);
    console.error('OIDC start error:', err.message);
    return oidcError(res, action, 'Failed to initiate SSO');
  }
});

// Step 2: handle the authorization code callback from the OIDC provider
oidcBrowserRouter.get('/:slug/callback', async (req, res) => {
  const code = queryString(req.query.code);
  const state = queryString(req.query.state);
  const error = queryString(req.query.error);
  const error_description = queryString(req.query.error_description);

  const pending = req.session.oidcPending;
  const pendingAction = pending?.action || 'login';

  if (error) {
    console.error('OIDC provider error:', error, error_description);
    return oidcError(res, pendingAction, error_description || error);
  }

  if (!pending || Date.now() > pending.expiresAt) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'SSO session expired — please try again');
  }
  if (!state || state !== pending.state) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'Invalid SSO state — please try again');
  }
  if (!code) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'No authorization code received');
  }

  // Clear the pending state before any async work so it cannot be replayed
  delete req.session.oidcPending;

  const client = await pool.connect();
  try {
    const provResult = await client.query<OidcProviderRow>(
      'SELECT * FROM oidc_providers WHERE id = $1 AND enabled = true',
      [pending.providerId]
    );
    if (!provResult.rows.length) {
      return oidcError(res, pending.action, 'SSO provider not found or disabled');
    }
    const provider = provResult.rows[0];
    const { doc, jwks } = await getDiscovery(provider.issuer_url, provider.allow_insecure);
    const redirectUri = getRedirectUri(provider);
    const clientSecret = isEncrypted(provider.client_secret)
      ? decrypt(provider.client_secret)
      : provider.client_secret;
    if (isEncrypted(provider.client_secret) && clientSecret === null) {
      console.error('OIDC client secret decryption failed');
      return oidcError(res, pending.action, 'OIDC provider configuration error');
    }

    // Exchange authorization code for tokens
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.client_id,
      code_verifier: pending.verifier,
    });
    if (clientSecret !== null && clientSecret !== undefined) {
      tokenParams.set('client_secret', clientSecret);
    }
    const tokenFetch = provider.allow_insecure ? makeInsecureFetch() : fetch;
    const tokenRes = await tokenFetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenParams.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('OIDC token exchange failed:', tokenRes.status, body);
      return oidcError(res, pending.action, 'Token exchange failed');
    }
    const tokenData = (await tokenRes.json()) as OidcTokenResponse;

    // Verify id_token — strict issuer + audience validation
    let payload: OidcIdTokenClaims;
    try {
      const idToken = tokenData.id_token;
      if (!idToken) throw new Error('OIDC token response did not include an id_token');
      const { payload: p } = await jwtVerify<OidcIdTokenClaims>(idToken, jwks, {
        issuer: doc.issuer,
        audience: provider.client_id,
      });
      payload = p;
    } catch (caught) {
      const err = toAppError(caught);
      console.error('OIDC id_token verification failed:', err.message);
      return oidcError(res, pending.action, 'Token verification failed');
    }

    if (payload.nonce !== pending.nonce) {
      return oidcError(res, pending.action, 'Nonce mismatch — please try again');
    }

    const subject = payload.sub;
    const issuer = payload.iss;
    const email = payload.email || null;
    // Accept a boolean true or a stringified "true" — some IdPs emit the claim as a string.
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';

    // Require verified email for login flows (skip for link, and skip if provider opts out)
    if (!emailVerified && pending.action !== 'link' && provider.require_email_verified !== false) {
      return oidcError(res, pending.action, 'Your email address must be verified with this SSO provider');
    }

    // Enforce allowed_domains if configured — requires verified email for all flows including link
    if (provider.allowed_domains) {
      const allowed = provider.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
      if (allowed.length > 0) {
        if (!email || (!emailVerified && provider.require_email_verified !== false)) {
          return oidcError(res, pending.action, 'A verified email address is required for this SSO provider');
        }
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !allowed.includes(domain)) {
          return oidcError(res, pending.action, 'Your email domain is not permitted for this SSO provider');
        }
      }
    }

    // ── Link action: add this identity to an already-authenticated account ────
    if (pending.action === 'link') {
      if (!pending.linkUserId) {
        return oidcError(res, 'link', 'Link session invalid');
      }
      try {
        await client.query(
          `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [pending.linkUserId, provider.id, issuer, subject, email, emailVerified]
        );
      } catch (caught) {
        const err = toAppError(caught);
        if (err.code === '23505') {
          return oidcError(res, 'link', 'This identity is already linked to another account');
        }
        throw err;
      }
      return res.redirect('/?oidc_success=linked');
    }

    // ── Login action: find or provision a Inboxora user ───────────────────────
    const existingId = await client.query(
      'SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );

    if (existingId.rows.length) {
      // Known identity — look up the user and log in
      const userId = existingId.rows[0].user_id;
      const userRow = await client.query(
        'SELECT id, username, is_admin FROM users WHERE id = $1',
        [userId]
      );
      if (!userRow.rows.length) {
        return oidcError(res, 'login', 'Account not found');
      }
      const user = userRow.rows[0];

      // Re-evaluate admin status from group claim on every login (if configured)
      const adminFromClaim = resolveAdminFromClaim(payload, provider);
      if (adminFromClaim !== null && adminFromClaim !== user.is_admin) {
        await client.query('UPDATE users SET is_admin = $1 WHERE id = $2', [adminFromClaim, user.id]);
        user.is_admin = adminFromClaim;
      }

      await client.query(
        'UPDATE user_identities SET last_used_at = NOW() WHERE issuer = $1 AND subject = $2',
        [issuer, subject]
      );
      await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin;
      rememberOidcSession(req, provider.id, tokenData.id_token);
      await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      imapManager.connectAllForUser(user.id);
      logAuthEvent('sso_login', { username: user.username, userId: user.id, ip: req.ip, success: true });
      return res.redirect('/?oidc_success=login');
    }

    // No existing identity — consult provisioning_mode
    const mode = provider.provisioning_mode;

    if (mode === 'disabled') {
      return oidcError(res, 'login', 'SSO login is not enabled for new users on this server');
    }

    if (mode === 'login_existing_only') {
      // A verified email is still required as a baseline assurance (opt-out via
      // require_email_verified), even when matching on a different claim.
      if (!email || (!emailVerified && provider.require_email_verified !== false)) {
        return oidcError(res, 'login', 'No account found. Contact your administrator.');
      }
      // Match ONLY on the canonical identity (users.username), via the admin-configured
      // login_match_claim (default 'email'). We deliberately do NOT fall back to matching any
      // owned email_accounts.email_address: proving control of an address that a user added as a
      // secondary mailbox must not log you in as that user (identity-confusion / account-takeover
      // risk with shared mailboxes).
      const matchValue = resolveLoginMatchValue(provider, payload, email);
      if (!matchValue) {
        return oidcError(res, 'login', 'No account found matching this identity. Contact your administrator.');
      }
      const { rows: [user] } = await client.query(
        'SELECT id, username, is_admin FROM users WHERE username = $1',
        [matchValue]
      );
      if (!user) {
        return oidcError(res, 'login', 'No account found matching this identity. Contact your administrator.');
      }

      // Evaluate admin status from group claim on first SSO link (if configured)
      const adminFromClaim = resolveAdminFromClaim(payload, provider);
      if (adminFromClaim !== null && adminFromClaim !== user.is_admin) {
        await client.query('UPDATE users SET is_admin = $1 WHERE id = $2', [adminFromClaim, user.id]);
        user.is_admin = adminFromClaim;
      }

      await client.query(
        `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = NOW()`,
        [user.id, provider.id, issuer, subject, email, emailVerified]
      );
      await maybeBackfillDisplayName(client, user.id, payload);
      await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin;
      rememberOidcSession(req, provider.id, tokenData.id_token);
      await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      imapManager.connectAllForUser(user.id);
      logAuthEvent('sso_login', { username: user.username, userId: user.id, ip: req.ip, success: true });
      return res.redirect('/?oidc_success=login');
    }

    if (mode === 'open') {
      // Create a new Inboxora account from the SSO identity. An email is always
      // required; the *verified* requirement is opt-out via require_email_verified
      // (matching the login_existing_only and allowed_domains checks above).
      if (!email || (!emailVerified && provider.require_email_verified !== false)) {
        return oidcError(res, 'login', 'A verified email address is required to create an account via SSO');
      }
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(7936352)');
        // Reuse existing account if username (email) already taken
        const existingUser = await client.query(
          'SELECT id, username, is_admin FROM users WHERE username = $1',
          [email.toLowerCase()]
        );
        const adminFromClaim = resolveAdminFromClaim(payload, provider);
        let user;
        if (existingUser.rows.length) {
          user = existingUser.rows[0];
          // Evaluate admin status from group claim on first SSO link (if configured)
          if (adminFromClaim !== null && adminFromClaim !== user.is_admin) {
            await client.query('UPDATE users SET is_admin = $1 WHERE id = $2', [adminFromClaim, user.id]);
            user = { ...user, is_admin: adminFromClaim };
          }
        } else {
          const countRow = await client.query('SELECT COUNT(*) AS count FROM users');
          const isFirstUser = parseInt(countRow.rows[0].count) === 0;
          // Admin is granted ONLY via a verified group claim — never via the
          // "first user" bootstrap for SSO-provisioned accounts. Otherwise, if a
          // provider were ever enabled before a local admin exists, the first
          // external SSO login would silently become admin. The initial admin must
          // be created through local registration.
          const isAdmin = adminFromClaim === true;
          const newUser = await client.query(
            'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, NULL, $2) RETURNING id, username, is_admin',
            [email.toLowerCase(), isAdmin]
          );
          user = newUser.rows[0];
          if (isFirstUser) {
            await client.query(
              `INSERT INTO system_settings (key, value, updated_at) VALUES ('registration_open', 'false', NOW())
               ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
            );
          }
        }
        await ensureUserDavResources(client, user.id);
        await client.query(
          `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = NOW()`,
          [user.id, provider.id, issuer, subject, email, emailVerified]
        );
        await maybeBackfillDisplayName(client, user.id, payload);
        await client.query('COMMIT');
        await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;
        rememberOidcSession(req, provider.id, tokenData.id_token);
        await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        imapManager.connectAllForUser(user.id);
        logAuthEvent('sso_login', { username: user.username, userId: user.id, ip: req.ip, success: true });
        return res.redirect('/?oidc_success=login');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    return oidcError(res, 'login', 'Unknown provisioning configuration');
  } catch (caught) {
    const err = toAppError(caught);
    console.error('OIDC callback error:', err.message);
    return oidcError(res, pending?.action || 'login', 'Authentication failed. Please try again.');
  } finally {
    client.release();
  }
});
