import { authorizationResultQuery, finalizeProviderAuthorization, isFinalizablePurpose } from '../services/providerAuthorizationFinalizer.js';
import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { readProviderSwitches } from '../services/providerSwitches.js';
import { requireAuth } from '../middleware/auth.js';
import { toAppError } from '../utils/errors.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  ProviderAuthError,
  createAuthorizationFlow,
  exchangeGoogleAuthorizationCode,
  fetchGoogleIdentity,
  finishAuthorizationFlow,
  googleAuthorizeUrl,
  googleConfigFromEnv,
  googleScopesForPurpose,
  isAuthorizationPurpose,
  isGoogleConfigured,
  providerConfigRevision,
  storeOAuthGrant,
  takeAuthorizationFlow,
  inspectAuthorizationFlow,
  upsertProviderConnection,
} from '../services/providerAuthService.js';
import type { AuthorizationPurpose, GoogleConfig, RequestedAccess } from '../services/providerAuthService.js';
import type { Request, Response } from 'express';

/**
 * Google web OAuth (P04, plan §6.3/§6.6/§6.7).
 *
 * Authorization-code + PKCE for a Web-application client: the client secret stays
 * on the backend, the one-time state is stored hashed and single-use, and the
 * callback is bound to the session that started the flow. No device-code variant
 * exists because Google does not allow the Gmail/Calendar/People scopes in that
 * flow.
 *
 * This route does not create a mail account: choosing the Gmail API as the mail
 * transport is a separate, explicit migration step. It records the verified
 * provider connection and grant that the calendar/contact and mail adapters use.
 */

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function googleConfig(): GoogleConfig {
  // One source of truth for the effective client configuration.
  return googleConfigFromEnv();
}

function failRedirect(res: Response, message: string, status = 302) {
  // `res.redirect(url)` always forces 302; pass the status explicitly so a 403
  // session mismatch is not silently downgraded.
  return res.redirect(status, `/?oauth_error=${encodeURIComponent(message)}`);
}

/**
 * An omitted purpose keeps the historical default; a purpose that was explicitly sent but is not one this
 * build implements is rejected instead of being reinterpreted. Silently coercing it to `new_account` is what
 * made "reconnect this mailbox" (`account_enable`) store an unrelated flow whose callback never finalized the
 * mailbox's services, so the card waited forever (AUTH-01).
 */
function readPurpose(value: unknown): AuthorizationPurpose | null {
  if (value === undefined || value === '') return 'new_account';
  return isAuthorizationPurpose(value) ? value : null;
}

function readAccess(value: unknown): RequestedAccess {
  return value === 'read_only' ? 'read_only' : 'source';
}

// Start: the authenticated user is redirected to Google's consent screen.
router.get('/google', requireAuth, async (req: Request, res: Response) => {
  const config = googleConfig();
  if (!isGoogleConfigured(config)) return failRedirect(res, 'Google API is not configured');
  // An administrator can switch the provider or its API method off; the readiness report
  // already says so, and the flow must agree with it rather than starting anyway.
  const switches = await readProviderSwitches('google');
  if (!switches.enabled || !switches.apiEnabled) return failRedirect(res, 'Google API is disabled by the administrator');
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
    const scopes = googleScopesForPurpose(purpose, access);
    const flow = await withTransaction(client => createAuthorizationFlow(client, {
      userId,
      provider: 'google',
      purpose,
      targetAccountId: requestedAccount,
      scopes,
      returnRoute: '/settings',
      configRevision: providerConfigRevision(config),
      authFlow: 'browser',
    }));
    const authorizeUrl = googleAuthorizeUrl({
      config,
      scopes,
      state: flow.state,
      codeChallenge: flow.codeChallenge,
      nonce: flow.nonce,
    });
    return res.redirect(authorizeUrl);
  } catch (caught) {
    const error = toAppError(caught);
    console.error('Google OAuth start failed:', error.message);
    return failRedirect(res, 'Could not start Google authorization');
  }
});

// Callback: exchange the code for tokens, verify the identity and store the grant.
router.get('/google/callback', async (req: Request, res: Response) => {
  const config = googleConfig();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';

  let flowId: string | null = null;
  try {
    if (typeof req.query.error === 'string' && req.query.error) {
      // The user declined or the provider rejected the request; consume the flow
      // so a replayed callback cannot complete it later.
      if (state) {
        await withTransaction(async client => {
          const taken = await takeAuthorizationFlow(client, { state, provider: 'google' });
          if (taken) await finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'PROVIDER_DENIED' });
        }).catch(() => {});
      }
      return failRedirect(res, 'Google authorization was denied');
    }
    if (!isGoogleConfigured(config)) return failRedirect(res, 'Google API is not configured');
    if (!state || !code) return failRedirect(res, 'Missing code or state');

    const taken = await withTransaction(client => takeAuthorizationFlow(client, { state, provider: 'google' }));
    if (!taken) {
      // A state is single-use. A second callback for a consent that already succeeded is not a failure: the
      // grant is stored, and reporting "Invalid OAuth state" told the user their connection had not worked when
      // it had. The remaining cases keep their own message so the cause is visible.
      const status = await withTransaction(client => inspectAuthorizationFlow(client, { state, provider: 'google' }));
      if (status === 'completed' || status === 'exchanging') return res.redirect('/?oauth_success=google');
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
      return failRedirect(res, 'Google configuration changed during authorization');
    }
    if (!taken.codeVerifier) {
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: taken.id, status: 'failed', errorCode: 'MISSING_PKCE_VERIFIER' }));
      return failRedirect(res, 'Invalid authorization state');
    }

    const tokens = await exchangeGoogleAuthorizationCode({
      code,
      codeVerifier: taken.codeVerifier,
      config,
    });
    const identity = await fetchGoogleIdentity({ accessToken: tokens.accessToken });

    const authorization = await withTransaction(async client => {
      const connectionId = await upsertProviderConnection(client, {
        userId: taken.userId,
        provider: 'google',
        issuer: GOOGLE_ISSUER,
        subject: identity.subject,
        providerUserId: identity.email,
        clientConfigId: config.clientId,
      });
      await storeOAuthGrant(client, {
        connectionId,
        audience: GOOGLE_GRANT_AUDIENCE,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        // Prefer the scopes the provider actually granted over what we asked for.
        scopes: tokens.scopes.length ? tokens.scopes : taken.requestedScopes,
        authFlow: 'browser',
        clientAuthMethod: 'confidential',
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

    // The consent stored its grant; run the synchronisation the purpose implied **now**, rather than leaving
    // the calendar or the address book empty until a scheduler tick. A failure here keeps the grant and is
    // reported to the opener, which shows "connected, synchronisation failed" instead of "not connected".
    // `new_account` only attaches the authorization, so it has no first run to make.
    if (!isFinalizablePurpose(authorization.purpose)) {
      return res.redirect('/?oauth_success=google');
    }
    const result = await finalizeProviderAuthorization({
      userId: taken.userId,
      provider: 'google',
      purpose: authorization.purpose,
      targetAccountId: authorization.targetAccountId,
      connectionId: authorization.connectionId,
      googleConfig: config,
    });

    return res.redirect(`/?oauth_success=google&${authorizationResultQuery(result)}`);
  } catch (caught) {
    const error = toAppError(caught);
    const code2 = caught instanceof ProviderAuthError ? caught.code : 'AUTH_FAILED';
    console.error('Google OAuth callback error:', code2, error.message);
    if (flowId) {
      // Capture the id in a const: the closure below would otherwise widen it back.
      const failedFlowId = flowId;
      await withTransaction(client => finishAuthorizationFlow(client, { flowId: failedFlowId, status: 'failed', errorCode: code2 })).catch(() => {});
    }
    return failRedirect(res, 'Google authentication failed');
  }
});

export default router;
