import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { toAppError } from '../utils/errors.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  ProviderAuthError,
  createAuthorizationFlow,
  exchangeMicrosoftAuthorizationCode,
  fetchMicrosoftIdentity,
  finishAuthorizationFlow,
  isMicrosoftConfigured,
  microsoftAuthorizeUrl,
  microsoftConfigFromEnv,
  microsoftScopesForPurpose,
  providerConfigRevision,
  storeOAuthGrant,
  takeAuthorizationFlow,
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
const PURPOSES: readonly AuthorizationPurpose[] = ['new_account', 'mail_migration', 'calendar_enable', 'contacts_enable'];

function failRedirect(res: Response, message: string, status = 302) {
  // `res.redirect(url)` always forces 302; pass the status explicitly so a 403
  // session mismatch is not silently downgraded.
  return res.redirect(status, `/?oauth_error=${encodeURIComponent(message)}`);
}

function readPurpose(value: unknown): AuthorizationPurpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value)
    ? value as AuthorizationPurpose
    : 'new_account';
}

function readAccess(value: unknown): RequestedAccess {
  return value === 'read_only' ? 'read_only' : 'source';
}

// Start: the authenticated user is redirected to Microsoft's consent screen.
router.get('/provider/microsoft', requireAuth, async (req: Request, res: Response) => {
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) return failRedirect(res, 'Microsoft API is not configured');
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const purpose = readPurpose(req.query.purpose);
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

// Callback: exchange the code for tokens, read the identity and store the grant.
router.get('/provider/microsoft/callback', async (req: Request, res: Response) => {
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
    if (!taken) return failRedirect(res, 'Invalid or expired authorization state');
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

    await withTransaction(async client => {
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
    });

    return res.redirect('/?oauth_success=microsoft_graph');
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
