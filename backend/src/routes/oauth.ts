import { randomBytes, randomUUID } from 'crypto';
import type { EmailAccountRow } from '../services/imapManager.js';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, withTransaction } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { redactEmail } from '../utils/redact.js';
import { queryString } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import { readProviderSwitches } from '../services/providerSwitches.js';
import type { Request, Response } from 'express';
import type { DbClient } from '../services/db.js';

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/** Claims read from the verified Microsoft id_token. */
type MicrosoftIdTokenClaims = {
  tid?: string;
  iss?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  [claim: string]: unknown;
};

/**
 * x-www-form-urlencoded body. Values are stringified exactly as URLSearchParams does
 * for its record form, so an absent env var still serializes as the literal "undefined"
 * instead of being dropped.
 */
function formBody(values: Record<string, string | number | boolean | undefined>): URLSearchParams {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]): [string, string] => [key, String(value)])
  );
}

// Cache JWKS fetchers per tenant — createRemoteJWKSet handles caching internally.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getMsJwks(tenantId: string) {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
  );
  jwksCache.set(tenantId, jwks);
  return jwks;
}

const router = Router();

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

// In-memory store for pending device code flows — keyed by userId.
// Device codes expire in 15 minutes so no persistence is needed.
const deviceFlows = new Map();

function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// Step 1: redirect user to Microsoft login
router.get('/microsoft', async (req: Request, res: Response) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const switches = await readProviderSwitches('microsoft');
  if (!switches.enabled || !switches.webEnabled) {
    return res.status(403).json({ error: 'The Microsoft web sign-in is disabled in the Integrations settings.' });
  }

  const { clientId, tenantId, redirectUri } = getMsConfig();
  if (!clientId || !tenantId || !redirectUri) {
    return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI in .env' });
  }

  // Generate a random CSRF nonce for the state parameter and store it alongside
  // the userId so the callback can verify it without trusting the state value.
  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    state: oauthNonce,
    prompt: 'select_account',
  });

  // Save session before redirecting so the nonce is committed to the store
  // before the external provider redirects back with the authorization code.
  await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/authorize?${params}`);
});

// Step 2: Microsoft redirects back here with auth code
router.get('/microsoft/callback', async (req: Request, res: Response) => {
  const code = queryString(req.query.code);
  const state = queryString(req.query.state);
  const error = queryString(req.query.error);
  const error_description = queryString(req.query.error_description);

  if (error) {
    console.error('Microsoft OAuth error:', error, error_description);
    return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  // Validate CSRF nonce BEFORE making any external requests
  if (!state || state !== req.session.oauthNonce) {
    return res.redirect(`/?oauth_error=${encodeURIComponent('Invalid OAuth state — please try again')}`);
  }
  const userId = req.session.oauthUserId;
  if (!userId) return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth session expired — please try again')}`);
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;

  const { clientId, clientSecret, tenantId, redirectUri } = getMsConfig();

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });

    const tokens = (await tokenRes.json()) as OAuthTokenResponse;
    if (!tokenRes.ok) {
      throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    }

    // Authorization-code flow uses the client secret → confidential client.
    await processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient: false });

    // Redirect back to app with success
    res.redirect('/?oauth_success=microsoft');
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err);
    res.redirect('/?oauth_error=Authentication+failed');
  }
});

// Shared: validate tokens, upsert account, connect IMAP.
async function processMicrosoftTokens(
  userId: string,
  tokens: OAuthTokenResponse,
  { tenantId, clientId, publicClient = false }: { tenantId: string; clientId: string | undefined; publicClient?: boolean },
) {
  const { access_token, refresh_token, expires_in, id_token } = tokens;
  if (!access_token || !refresh_token) {
    throw new Error('OAuth token response is missing access or refresh token — please reconnect your account');
  }
  const expiresInSecs = typeof expires_in === 'number' && Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSecs * 1000);

  // Validate the id_token via Microsoft's JWKS, then extract user info.
  // The access_token is scoped to outlook.office.com (IMAP/SMTP) and cannot be used
  // with graph.microsoft.com, so id_token is the right source for email/name.
  let email = null;
  let displayName = null;
  if (id_token) {
    const jwks = getMsJwks(tenantId);
    const verifyOpts: { audience: string | undefined; issuer?: string } = { audience: clientId };
    // For multi-tenant ('common'/'organizations'/'consumers'), issuers vary per tenant,
    // so we skip issuer validation and rely on audience + signature instead.
    const fixedTenants = new Set(['common', 'organizations', 'consumers']);
    if (!fixedTenants.has(tenantId)) {
      verifyOpts.issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    }
    try {
      const { payload } = await jwtVerify<MicrosoftIdTokenClaims>(id_token, jwks, verifyOpts);
      // For multi-tenant configs the issuer check is skipped above, so validate that
      // the iss claim matches the token's own tid.  This prevents cross-tenant identity
      // injection where an attacker creates a Microsoft tenant with the victim's email,
      // obtains a JWT signed by Microsoft, and submits it to an Inboxora instance
      // configured for 'common'.
      if (fixedTenants.has(tenantId) && payload.tid && payload.iss) {
        const expectedIss = `https://login.microsoftonline.com/${payload.tid}/v2.0`;
        if (payload.iss !== expectedIss) {
          throw new Error(`id_token issuer mismatch: expected ${expectedIss}, got ${payload.iss}`);
        }
      }
      email = payload.email || payload.preferred_username || null;
      displayName = payload.name || null;
    } catch (caught) {
      const jwtErr = toAppError(caught);
      console.error('Microsoft id_token validation failed:', jwtErr.message);
      throw new Error('Could not validate Microsoft identity token — please try again', { cause: caught });
    }
  }

  if (!email) throw new Error('Could not retrieve email address from Microsoft profile — ensure the openid, email, and profile scopes are granted');

  // Serialize the check-then-insert per (user, email) with a transaction-scoped
  // advisory lock. Two OAuth callbacks racing for the same mailbox would otherwise
  // both miss the SELECT and each INSERT, producing duplicate account rows. The
  // second waiter blocks until the first commits, then sees the row and updates it.
  const account = await withTransaction(async (client: DbClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`oauth-account:${userId}:${email.toLowerCase()}`]);

    const existing = await client.query(
      'SELECT id FROM email_accounts WHERE user_id = $1 AND lower(email_address) = lower($2)',
      [userId, email]
    );

    let accountId;
    if (existing.rows.length) {
      accountId = existing.rows[0].id;
      await client.query(`
        UPDATE email_accounts SET
          oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
          name = $4, oauth_public_client = $5, oauth_provider = 'microsoft', sync_error = NULL
        WHERE id = $6
      `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, publicClient, accountId]);
    } else {
      const colors = ['#0078d4', '#106ebe', '#005a9e', '#004578'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const result = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client
        ) VALUES ($1,$2,$3,$4,'imap',
          'outlook.office365.com', 993, true,
          'smtp.office365.com', 587, 'STARTTLS',
          $3,
          'microsoft', $5, $6, $7,
          $8)
        RETURNING *
      `, [userId, displayName, email, color, encrypt(access_token), encrypt(refresh_token), expiry, publicClient]);
      accountId = result.rows[0].id;
    }

    const accountResult = await client.query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return accountResult.rows[0];
  });

  imapManager.connectAccount(account).catch(err =>
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err.message)
  );
  return email;
}

// Step 1: initiate device code flow — returns user_code + verification_uri to the frontend.
router.post('/microsoft/device', async (req: Request, res: Response) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { clientId, tenantId } = getMsConfig();
  if (!clientId || !tenantId) {
    return res.status(400).json({ error: 'Microsoft integration not configured. Set Client ID and Tenant ID in the Integrations tab.' });
  }
  // The saved configuration can switch this method off. The readiness report already says
  // so, and the interface honours it — but reporting a method as unavailable while the
  // route still starts it makes the setting decoration for anything that bypasses the UI.
  // The saved configuration can switch the provider or this method off. The readiness
  // report already says so, and the interface honours it — but reporting a method as
  // unavailable while the route still starts it makes the setting decoration.
  {
    const switches = await readProviderSwitches('microsoft');
    if (!switches.enabled || !switches.deviceEnabled) {
      return res.status(403).json({ error: 'The Microsoft device-code method is disabled in the Integrations settings.' });
    }
  }

  try {
    const dcRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const dc = (await dcRes.json()) as DeviceCodeResponse;
    if (!dcRes.ok) {
      throw new Error(dc.error_description || dc.error || 'Failed to start device code flow');
    }

    // Keyed by a flow id rather than by the user: one user may legitimately start a second flow
    // (another mailbox) while the first is still pending, and keying by user made the second silently
    // replace the first — the first poll would then report the second flow's state. The owner is stored
    // inside the entry, and the poll checks it, so another session still cannot reach this flow.
    const flowId = randomUUID();
    deviceFlows.set(flowId, {
      flowId,
      userId: req.session.userId,
      deviceCode: dc.device_code,
      tenantId,
      clientId,
      // The interval Microsoft asks for, and when this flow was last polled. Both are needed to keep a
      // misbehaving client from turning each of its polls into a call to Microsoft: the interface respects
      // the interval, but nothing stopped another caller from ignoring it.
      intervalSeconds: dc.interval || 5,
      lastPolledAt: 0,
      expiresAt: Date.now() + dc.expires_in * 1000,
    });

    res.json({
      flowId,
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      expiresIn: dc.expires_in,
      interval: dc.interval || 5,
    });
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Device code init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: poll for token — called repeatedly by the frontend until resolved.
router.get('/microsoft/device/poll', async (req: Request, res: Response) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // Prefer the flow the client names; fall back to the user's own pending flow so a client that predates
  // the flow id keeps working. Either way the entry must belong to this session's user.
  const requestedFlowId = queryString(req.query.flowId);
  const flow = requestedFlowId
    ? deviceFlows.get(requestedFlowId)
    : [...deviceFlows.values()].filter(candidate => candidate.userId === req.session.userId).at(-1);
  if (!flow || flow.userId !== req.session.userId) {
    return res.status(400).json({ status: 'error', error: 'No pending device code flow' });
  }
  if (Date.now() > flow.expiresAt) {
    deviceFlows.delete(flow.flowId);
    return res.json({ status: 'expired' });
  }

  // The device grant is polled, and every poll here is a call to Microsoft. Microsoft's own answer to too
  // frequent polling is `slow_down`; not calling at all until the interval has passed is the cheaper version,
  // and it keeps this endpoint from being a way to make the server hammer the provider.
  const intervalMs = Math.max(1, Number(flow.intervalSeconds) || 5) * 1000;
  if (Date.now() - Number(flow.lastPolledAt ?? 0) < intervalMs) {
    return res.json({ status: 'pending' });
  }
  flow.lastPolledAt = Date.now();

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${flow.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: flow.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tokens = (await tokenRes.json()) as OAuthTokenResponse;

    if (tokens.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (tokens.error === 'authorization_declined') {
      deviceFlows.delete(flow.flowId);
      return res.json({ status: 'declined' });
    }
    if (tokens.error === 'expired_token') {
      deviceFlows.delete(flow.flowId);
      return res.json({ status: 'expired' });
    }
    if (!tokenRes.ok) {
      deviceFlows.delete(flow.flowId);
      return res.json({ status: 'error', error: tokens.error_description || tokens.error || 'Token exchange failed' });
    }

    deviceFlows.delete(flow.flowId);
    // Device-code flow never uses a client secret → public client. Its refresh must
    // omit the secret too, or Microsoft rejects it with AADSTS90023 (#216).
    await processMicrosoftTokens(req.session.userId, tokens, { tenantId: flow.tenantId, clientId: flow.clientId, publicClient: true });
    res.json({ status: 'success' });
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Device code poll error:', err.message);
    deviceFlows.delete(flow.flowId);
    res.json({ status: 'error', error: err.message });
  }
});

// Serialize refreshes per account so concurrent callers share one token-endpoint
// call — AAD rotates the refresh token on each refresh, and two racing refreshes
// would strand a superseded refresh token and lock the account out.
/** The account columns the Microsoft refresh path reads. */
type MicrosoftRefreshAccount = Pick<EmailAccountRow, 'id'> & {
  oauth_refresh_token?: string | null;
  oauth_public_client?: boolean | null;
};

/** An account row plus the plaintext tokens a refresh hands back to its caller.
 *  Partial because callers/tests may pass a subset of the row. */
type RefreshedMicrosoftAccount = Partial<EmailAccountRow> & {
  oauth_refresh_token?: string | null;
  oauth_public_client?: boolean | null;
  [key: string]: unknown;
};

const inFlightMsRefresh = new Map<string, Promise<RefreshedMicrosoftAccount>>(); // accountId -> Promise
export function refreshMicrosoftToken(account: EmailAccountRow): Promise<EmailAccountRow>;
export function refreshMicrosoftToken(account: MicrosoftRefreshAccount): Promise<RefreshedMicrosoftAccount>;
export function refreshMicrosoftToken(
  account: MicrosoftRefreshAccount,
): Promise<EmailAccountRow | RefreshedMicrosoftAccount> {
  const existing = inFlightMsRefresh.get(account.id);
  if (existing) return existing;
  const p = doRefreshMicrosoftToken(account).finally(() => inFlightMsRefresh.delete(account.id));
  inFlightMsRefresh.set(account.id, p);
  return p;
}

// Refresh an expired Microsoft token
async function doRefreshMicrosoftToken(account: MicrosoftRefreshAccount): Promise<RefreshedMicrosoftAccount> {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) throw new Error('OAuth refresh token is missing or corrupted — please reconnect your account');

  // Public clients (device-code flow — personal Outlook.com/Hotmail) must NOT send a
  // client_secret on refresh: Microsoft rejects it with AADSTS90023 ("Public clients
  // can't send a client secret"). Confidential clients (auth-code flow) must send it.
  // Key this on the account's recorded flow, not on whether a secret is configured
  // globally, since one instance can host both kinds. (#216)
  const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`;
  const postRefresh = (withSecret: boolean) => {
    const params = formBody({
      client_id: clientId,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    });
    if (withSecret && clientSecret) params.set('client_secret', clientSecret);
    return fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(10000),
    });
  };

  const sendSecret = !!clientSecret && !account.oauth_public_client;
  let tokenRes = await postRefresh(sendSecret);
  let tokens = (await tokenRes.json()) as OAuthTokenResponse;
  let becamePublic = false;

  // Self-heal accounts predating the oauth_public_client column: if we sent a secret
  // and Microsoft says a public client can't (AADSTS90023), this is really a public
  // (device-code) client — retry without the secret and record it so future refreshes
  // skip the secret straight away.
  if (!tokenRes.ok && sendSecret && /AADSTS90023/i.test(tokens.error_description || tokens.error || '')) {
    tokenRes = await postRefresh(false);
    tokens = (await tokenRes.json()) as OAuthTokenResponse;
    becamePublic = tokenRes.ok;
  }

  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token refresh failed');

  const { access_token, refresh_token, expires_in } = tokens;
  if (!access_token) throw new Error('Token refresh response is missing an access token — please reconnect your account');
  const refreshExpiresInSecs = typeof expires_in === 'number' && Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);
  const isPublic = !!account.oauth_public_client || becamePublic;

  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_public_client = $4
    WHERE id = $5
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, isPublic, account.id]);

  // Return plaintext tokens so callers can use them immediately without decrypting
  return { ...account, oauth_access_token: access_token, oauth_token_expiry: expiry, oauth_public_client: isPublic };
}

export default router;
