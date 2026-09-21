import { authorizationResultQuery, finalizeProviderAuthorization, isFinalizablePurpose } from '../services/providerAuthorizationFinalizer.js';
import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { readProviderSwitches } from '../services/providerSwitches.js';
import { toAppError } from '../utils/errors.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  ProviderAuthError,
  createAuthorizationFlow,
  exchangeMicrosoftAuthorizationCode,
  fetchMicrosoftIdentity,
  finishAuthorizationFlow,
  isAuthorizationPurpose,
  isMicrosoftConfigured,
  markDeviceAuthorizationPolled,
  microsoftAuthorizeUrl,
  microsoftConfigFromEnv,
  microsoftScopesForPurpose,
  pollMicrosoftDeviceAuthorization,
  providerConfigRevision,
  readDeviceAuthorizationFlow,
  startMicrosoftDeviceAuthorization,
  storeDeviceAuthorization,
  storeOAuthGrant,
  takeAuthorizationFlow,
  inspectAuthorizationFlow,
  upsertProviderConnection,
} from '../services/providerAuthService.js';
import type { AuthorizationPurpose, RequestedAccess } from '../services/providerAuthService.js';
import type { Request, Response } from 'express';

/**
 * Microsoft Graph web OAuth (P04/P07, plan §6.3/§6.6/§6.7).
 *
 * Authorization-code + PKCE for the Entra application: the client secret stays on
 * the backend, the one-time state is stored hashed and single-use, and the callback
 * is bound to the session that started the flow.
 *
 * Deliberately separate from `/oauth/microsoft`, which is the existing
 * account-connection flow: that one fetches IMAP/SMTP-scoped tokens for a mailbox,
 * while this one records the verified Graph connection and grant the API adapters
 * use. Mounting it here keeps the working Outlook sign-in untouched.
 *
 * This route does not create or migrate a mailbox. Choosing Graph as the mail
 * transport stays a separate, explicit step.
 */

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failRedirect(res: Response, message: string, status = 302) {
  // `res.redirect(url)` always forces 302; pass the status explicitly so a 403
  // session mismatch is not silently downgraded.
  return res.redirect(status, `/?oauth_error=${encodeURIComponent(message)}`);
}

/**
 * An omitted purpose keeps the historical default; a purpose that was explicitly sent but is not one this
 * build implements is rejected instead of being reinterpreted (AUTH-01). Both the browser and the device
 * start use this, so `account_enable` reaches the finalizer on either path.
 */
function readPurpose(value: unknown): AuthorizationPurpose | null {
  if (value === undefined || value === '') return 'new_account';
  return isAuthorizationPurpose(value) ? value : null;
}

function readAccess(value: unknown): RequestedAccess {
  return value === 'read_only' ? 'read_only' : 'source';
}

// Start: the authenticated user is redirected to Microsoft's consent screen.
router.get('/provider/microsoft', requireAuth, async (req: Request, res: Response) => {
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) return failRedirect(res, 'Microsoft API is not configured');
  // Same question as the readiness report: a provider or method the administrator switched
  // off must not be startable here either.
  const switches = await readProviderSwitches('microsoft');
  if (!switches.enabled || !switches.webEnabled) return failRedirect(res, 'Microsoft API is disabled by the administrator');
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const purpose = readPurpose(req.query.purpose);
  if (!purpose) return res.status(400).json({ error: 'Unsupported authorization purpose' });
  const access = readAccess(req.query.access);
  const requestedAccount = typeof req.query.accountId === 'string' && UUID_PATTERN.test(req.query.accountId) ? req.query.accountId : null;
  if (requestedAccount) {
    // The flow may only ever target an account the actor owns.
    const owned = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [requestedAccount, userId]);
    if (!owned.rows.length) return failRedirect(res, 'Account not found');
  }

  try {
    const scopes = microsoftScopesForPurpose(purpose, access);
    const flow = await withTransaction(client => createAuthorizationFlow(client, {
      userId,
      provider: 'microsoft',
      purpose,
      targetAccountId: requestedAccount,
      scopes,
      returnRoute: '/settings',
      configRevision: providerConfigRevision(config),
      authFlow: 'browser',
    }));
    return res.redirect(microsoftAuthorizeUrl({
      config,
      scopes,
      state: flow.state,
      codeChallenge: flow.codeChallenge,
      nonce: flow.nonce,
    }));
  } catch (caught) {
    const error = toAppError(caught);
    console.error('Microsoft Graph OAuth start failed:', error.message);
    return failRedirect(res, 'Could not start Microsoft authorization');
  }
});

// Device authorization: the same connection as the browser flow, for a deployment with no secret and
// no callback. The flow row holds the device code so a restart does not strand a pending authorization.
router.post('/provider/microsoft/device', requireAuth, async (req: Request, res: Response) => {
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) return res.status(409).json({ error: 'Microsoft API is not configured' });
  const switches = await readProviderSwitches('microsoft');
  // The device method has its own switch: a provider or method the administrator turned off must not be
  // startable here either, exactly as on the browser route.
  if (!switches.enabled || !switches.deviceEnabled) {
    return res.status(403).json({ error: 'Microsoft API is disabled by the administrator' });
  }
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const purpose = readPurpose(req.body?.purpose);
  if (!purpose) return res.status(400).json({ error: 'Unsupported authorization purpose' });
  const access = readAccess(req.body?.access);
  const requestedAccount = typeof req.body?.accountId === 'string' && UUID_PATTERN.test(req.body.accountId) ? req.body.accountId : null;
  if (requestedAccount) {
    const owned = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [requestedAccount, userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });
  }

  try {
    const scopes = microsoftScopesForPurpose(purpose, access);
    const started = await startMicrosoftDeviceAuthorization({ config, scopes });
    const flow = await withTransaction(async client => {
      const created = await createAuthorizationFlow(client, {
        userId,
        provider: 'microsoft',
        purpose,
        targetAccountId: requestedAccount,
        scopes,
        returnRoute: '/settings',
        configRevision: providerConfigRevision(config),
        authFlow: 'device_code',
        // The provider's own lifetime bounds the flow: an expired device code cannot be completed.
        ttlSeconds: started.expiresInSeconds,
      });
      await storeDeviceAuthorization(client, {
        flowId: created.flowId,
        deviceCode: started.deviceCode,
        intervalSeconds: started.intervalSeconds,
      });
      return created;
    });
    return res.json({
      flowId: flow.flowId,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresIn: started.expiresInSeconds,
      interval: started.intervalSeconds,
    });
  } catch (caught) {
    const error = toAppError(caught);
    console.error('Microsoft Graph device authorization start failed:', error.message);
    return res.status(502).json({ error: 'Could not start Microsoft authorization' });
  }
});

// One poll of the device authorization. The interface polls at the interval the provider asked for.
router.post('/provider/microsoft/device/poll', requireAuth, async (req: Request, res: Response) => {
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) return res.status(409).json({ error: 'Microsoft API is not configured' });
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const flowId = typeof req.body?.flowId === 'string' ? req.body.flowId : '';
  if (!UUID_PATTERN.test(flowId)) return res.status(400).json({ error: 'flowId required' });

  try {
    const flow = await withTransaction(client => readDeviceAuthorizationFlow(client, { flowId, userId }));
    if (!flow) return res.status(404).json({ status: 'error', error: 'No pending device authorization' });
    if (flow.status !== 'pending') {
      // A terminal flow is reported from its own state; the provider is not asked again.
      const terminal = flow.status === 'completed' ? 'success'
        : flow.status === 'expired' ? 'expired'
          : flow.status === 'cancelled' ? 'cancelled'
            : 'error';
      return res.json({ status: terminal });
    }
    if (flow.expiresAt.getTime() <= Date.now()) {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: flow.id, status: 'expired' })).catch(() => {});
      return res.json({ status: 'expired' });
    }
    // A poll before the provider's interval is answered from the flow's own state instead of becoming a
    // call to Microsoft: the interface respects the interval, and nothing else should be able to hammer
    // the provider through this endpoint.
    const intervalMs = Math.max(1, flow.intervalSeconds) * 1000;
    if (flow.lastPolledAt && Date.now() - flow.lastPolledAt.getTime() < intervalMs) {
      return res.json({ status: 'pending' });
    }
    if (!flow.deviceCode) {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: flow.id, status: 'failed', errorCode: 'DEVICE_CODE_MISSING' })).catch(() => {});
      return res.json({ status: 'error', error: 'This authorization has no device code' });
    }

    const result = await pollMicrosoftDeviceAuthorization({ config, deviceCode: flow.deviceCode });
    if (result.status === 'pending') {
      await withTransaction(client => markDeviceAuthorizationPolled(client, { flowId: flow.id })).catch(() => {});
      return res.json({ status: 'pending' });
    }
    if (result.status === 'slow_down') {
      await withTransaction(client => markDeviceAuthorizationPolled(client, {
        flowId: flow.id,
        ...(result.intervalSeconds !== undefined ? { intervalSeconds: result.intervalSeconds } : {}),
      })).catch(() => {});
      return res.json({ status: 'pending' });
    }
    if (result.status === 'declined') {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: flow.id, status: 'failed', errorCode: 'PROVIDER_DENIED' })).catch(() => {});
      return res.json({ status: 'declined' });
    }
    if (result.status === 'expired') {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: flow.id, status: 'expired' })).catch(() => {});
      return res.json({ status: 'expired' });
    }

    // Authorized: read the identity from Graph with the token we received server-to-server, then record
    // the connection and its grant. The identity is issuer + subject, never the address.
    const identity = await fetchMicrosoftIdentity({ accessToken: result.tokens.accessToken });
    const authorization = await withTransaction(async client => {
      const connectionId = await upsertProviderConnection(client, {
        userId: flow.userId,
        provider: 'microsoft',
        issuer: MICROSOFT_ISSUER,
        subject: identity.subject,
        tenantId: config.tenantId,
        providerUserId: identity.email,
        clientConfigId: config.clientId,
      });
      await storeOAuthGrant(client, {
        connectionId,
        audience: MICROSOFT_GRANT_AUDIENCE,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
        scopes: result.tokens.scopes.length ? result.tokens.scopes : flow.requestedScopes,
        authFlow: 'device_code',
        // A device grant is issued to a public client, so its refresh must omit the secret.
        clientAuthMethod: 'public',
        clientConfigId: config.clientId,
        clientIdAtIssue: config.clientId,
      });
      await finishAuthorizationFlow(client, { flowId: flow.id, status: 'completed' });
      // The mailbox this consent was started from now points at the connection the grant was stored on, so the
      // features the card reads and the grant the syncs use can never diverge. Without this, a mailbox whose
      // recorded connection was created earlier (at its mail cutover) kept reading that one, and a calendar or
      // contacts consent appeared to have granted nothing: the card said "missing Calendars.ReadWrite" while the
      // grant holding it sat on another connection of the same identity.
      if (flow.targetAccountId) {
        await client.query(
          'UPDATE email_accounts SET provider_connection_id = $1 WHERE id = $2 AND user_id = $3',
          [connectionId, flow.targetAccountId, flow.userId],
        );
      }
      return { connectionId, purpose: flow.purpose, targetAccountId: flow.targetAccountId };
    });

    // The consent is stored; run the synchronisation it implied now, so a calendar or address book is not left
    // empty until a scheduler tick, and report the outcome to the page that started the flow.
    const finalized = isFinalizablePurpose(authorization.purpose)
      ? await finalizeProviderAuthorization({
          userId: flow.userId,
          provider: 'microsoft',
          purpose: authorization.purpose,
          targetAccountId: authorization.targetAccountId,
          connectionId: authorization.connectionId,
          microsoftConfig: config,
        })
      : null;
    return res.json({ status: 'success', ...(finalized ? { result: { ...finalized, connectionId: undefined } } : {}) });
  } catch (caught) {
    const error = toAppError(caught);
    const code = caught instanceof ProviderAuthError ? caught.code : 'AUTH_FAILED';
    console.error('Microsoft Graph device poll error:', code, error.message);
    return res.json({ status: 'error', error: 'Microsoft authentication failed' });
  }
});

// Compatibility alias for unreleased dev revisions that registered the older provider callback.
router.get('/provider/microsoft/callback', (req: Request, res: Response) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, `/oauth/microsoft/callback${query}`);
});

// Callback: exchange the code for tokens, read the identity and store the grant.
router.get('/microsoft/callback', async (req: Request, res: Response) => {
  const config = microsoftConfigFromEnv();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';

  let flowId: string | null = null;
  try {
    if (typeof req.query.error === 'string' && req.query.error) {
      // The user declined or the provider rejected the request; consume the flow
      // so a replayed callback cannot complete it later.
      if (state) {
        await withTransaction(async client => {
          const taken = await takeAuthorizationFlow(client, { state, provider: 'microsoft' });
          if (taken) await finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'PROVIDER_DENIED' });
        }).catch(() => {});
      }
      return failRedirect(res, 'Microsoft authorization was denied');
    }
    if (!isMicrosoftConfigured(config)) return failRedirect(res, 'Microsoft API is not configured');
    if (!state || !code) return failRedirect(res, 'Missing code or state');

    const taken = await withTransaction(client => takeAuthorizationFlow(client, { state, provider: 'microsoft' }));
    if (!taken) {
      const status = await withTransaction(client => inspectAuthorizationFlow(client, { state, provider: 'microsoft' }));
      if (status === 'completed' || status === 'exchanging') return res.redirect('/?oauth_success=microsoft_graph');
      if (status === 'expired') return failRedirect(res, 'The authorization took too long and expired. Start it again.');
      if (status === 'failed' || status === 'cancelled') return failRedirect(res, 'That authorization was declined. Start it again.');
      return failRedirect(res, 'Invalid OAuth state - please start from the account card again');
    }
    flowId = taken.id;

    const sessionUserId = req.session.userId;
    if (!sessionUserId || sessionUserId !== taken.userId) {
      // A callback delivered into another session/user must not attach a grant.
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'SESSION_MISMATCH' }));
      return failRedirect(res, 'Authorization session mismatch', 403);
    }
    if (taken.configRevision && taken.configRevision !== providerConfigRevision(config)) {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'CONFIG_CHANGED' }));
      return failRedirect(res, 'Microsoft configuration changed during authorization');
    }
    if (!taken.codeVerifier) {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'MISSING_PKCE_VERIFIER' }));
      return failRedirect(res, 'Invalid authorization state');
    }

    const tokens = await exchangeMicrosoftAuthorizationCode({
      code,
      codeVerifier: taken.codeVerifier,
      config,
    });
    const identity = await fetchMicrosoftIdentity({ accessToken: tokens.accessToken });

    const browser = await withTransaction(async client => {
      const connectionId = await upsertProviderConnection(client, {
        userId: taken.userId,
        provider: 'microsoft',
        issuer: MICROSOFT_ISSUER,
        subject: identity.subject,
        tenantId: config.tenantId,
        providerUserId: identity.email,
        clientConfigId: config.clientId,
      });
      await storeOAuthGrant(client, {
        connectionId,
        audience: MICROSOFT_GRANT_AUDIENCE,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        // Prefer the scopes the provider actually granted over what we asked for.
        scopes: tokens.scopes.length ? tokens.scopes : taken.requestedScopes,
        authFlow: 'browser',
        // A browser authorization code is issued to the confidential web client;
        // refresh may still work without a secret for a public registration.
        clientAuthMethod: config.clientSecret ? 'confidential' : 'public',
        clientConfigId: config.clientId,
        clientIdAtIssue: config.clientId,
      });
      await finishAuthorizationFlow(client, { flowId: taken.id, status: 'completed' });
      // The mailbox this consent was started from now points at the connection the grant was stored on, so the
      // features the card reads and the grant the syncs use can never diverge. Without this, a mailbox whose
      // recorded connection was created earlier (at its mail cutover) kept reading that one, and a calendar or
      // contacts consent appeared to have granted nothing: the card said "missing Calendars.ReadWrite" while the
      // grant holding it sat on another connection of the same identity.
      if (taken.targetAccountId) {
        await client.query(
          'UPDATE email_accounts SET provider_connection_id = $1 WHERE id = $2 AND user_id = $3',
          [connectionId, taken.targetAccountId, taken.userId],
        );
      }
      return { connectionId, purpose: taken.purpose, targetAccountId: taken.targetAccountId };
    });

    if (!isFinalizablePurpose(browser.purpose)) {
      return res.redirect('/?oauth_success=microsoft_graph');
    }
    const finalizedBrowser = await finalizeProviderAuthorization({
      userId: taken.userId,
      provider: 'microsoft',
      purpose: browser.purpose,
      targetAccountId: browser.targetAccountId,
      connectionId: browser.connectionId,
      microsoftConfig: config,
    });

    return res.redirect(`/?oauth_success=microsoft_graph&${authorizationResultQuery(finalizedBrowser)}`);
  } catch (caught) {
    const error = toAppError(caught);
    const code2 = caught instanceof ProviderAuthError ? caught.code : 'AUTH_FAILED';
    console.error('Microsoft Graph OAuth callback error:', code2, error.message);
    if (flowId) {
      // Capture the id in a const: the closure below would otherwise widen it back.
      const failedFlowId = flowId;
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: failedFlowId, status: 'failed', errorCode: code2 })).catch(() => {});
    }
    return failRedirect(res, 'Microsoft authentication failed');
  }
});

export default router;
