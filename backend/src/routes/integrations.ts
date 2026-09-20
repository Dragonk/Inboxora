import { Router } from 'express';
import { providerIntegrationsEnabled } from '../services/providerSwitches.js';
import { collectionIsWritable } from '../services/providerAccess.js';
import { disconnectProviderConnection } from '../services/providerConnectionService.js';
import { microsoftConfigFromEnv } from '../services/providerAuthService.js';
import { listActiveGoogleMailRecommendations, suppressGoogleMailRecommendation } from '../services/accountNotices.js';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import { routeParam } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';
import { providerSyncIntervalMinutes } from '../services/providerSyncScheduler.js';
import {
  listSubscriptionDiagnostics,
  pushAvailability,
} from '../services/providerPushSubscriptions.js';
import { ensureGraphSubscriptions, microsoftPushAvailable } from '../services/providerPushMicrosoft.js';
import { ensureGoogleSubscriptions, gmailPushAvailable, googleCalendarPushAvailable } from '../services/providerPushGoogle.js';
import { releaseProviderPushForConnection } from '../services/providerPushLifecycle.js';
import { syncHintDiagnostics } from '../services/providerSyncHints.js';
import { publicWebhookUrl } from '../services/providerPushConfig.js';

const router = Router();
router.use(requireAuth);

/** Mask returned in place of a stored secret. Never persisted as a value. */
const SECRET_SENTINEL = '••••••••';

type ProviderName = 'microsoft' | 'google';

function isProviderName(value: unknown): value is ProviderName {
  return value === 'microsoft' || value === 'google';
}

/**
 * The stored configuration is an exact snapshot of what the admin saved (plus a
 * possible `disabled` tombstone). It is not a patch: a field that is absent
 * clears the matching env var so a removed value cannot leak in from `.env`
 * after a restart.
 */
type ProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  tenantId?: string;
  webEnabled?: boolean;
  deviceEnabled?: boolean;
  apiEnabled?: boolean;
  disabled?: boolean;
  disabledAt?: string;
};

const ENV_KEYS: Record<ProviderName, readonly string[]> = {
  microsoft: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
};

const FIELD_ENV: Record<ProviderName, Partial<Record<keyof ProviderConfig, string>>> = {
  microsoft: {
    clientId: 'MS_CLIENT_ID',
    clientSecret: 'MS_CLIENT_SECRET',
    tenantId: 'MS_TENANT_ID',
    redirectUri: 'MS_REDIRECT_URI',
  },
  google: {
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    redirectUri: 'GOOGLE_REDIRECT_URI',
  },
};

const ALLOWED_FIELDS: Record<ProviderName, readonly string[]> = {
  microsoft: ['clientId', 'clientSecret', 'clientSecretClear', 'redirectUri', 'tenantId', 'webEnabled', 'deviceEnabled', 'enabled'],
  google: ['clientId', 'clientSecret', 'clientSecretClear', 'redirectUri', 'apiEnabled', 'enabled'],
};

const STRING_FIELDS = ['clientId', 'clientSecret', 'redirectUri', 'tenantId'] as const;
const BOOLEAN_FIELDS = ['webEnabled', 'deviceEnabled', 'apiEnabled', 'clientSecretClear', 'enabled'] as const;
const MAX_STRING = 4096;
const MAX_SECRET = 8192;

/** Clear every env var belonging to a provider (used for disable and exact snapshots). */
function clearProviderEnv(provider: ProviderName): void {
  for (const key of ENV_KEYS[provider]) delete process.env[key];
}

/**
 * Apply a saved config to `process.env`, which is what the OAuth routes read
 * today. A disabled tombstone clears the provider instead of resurrecting the
 * previous `.env` values.
 */
function applyProviderConfig(provider: ProviderName, config: ProviderConfig): void {
  clearProviderEnv(provider);
  if (config.disabled) return;
  const env = FIELD_ENV[provider];
  const setString = (field: keyof ProviderConfig): void => {
    const key = env[field];
    const value = config[field];
    if (!key) return;
    if (typeof value === 'string' && value) process.env[key] = value;
  };
  setString('clientId');
  setString('tenantId');
  setString('redirectUri');
  const secretKey = env.clientSecret;
  if (secretKey && typeof config.clientSecret === 'string' && config.clientSecret) {
    const secret = isEncrypted(config.clientSecret) ? decrypt(config.clientSecret) : config.clientSecret;
    if (secret) process.env[secretKey] = secret;
  }
}

export interface ProviderReadiness {
  enabled: boolean;
  /** The caller's own connections for this provider; ids only, no credential. */
  connections?: Array<{ id: string; providerUserId: string | null; status: string }>;
  browser: { ready: boolean; missing: string[] };
  deviceCode: { supported: boolean; ready: boolean; reason?: string };
  /**
   * The Graph connector's own flow, which authorizes on a different callback from the
   * mailbox sign-in. Reported separately so the card can offer the connector exactly
   * where it can run, rather than tying it to the mailbox flow's readiness.
   */
  graph?: { ready: boolean; missing: string[] };
}

export interface IntegrationStatus {
  microsoft: ProviderReadiness & { mailPolicy: 'required'; configured: boolean };
  google: ProviderReadiness & {
    mailPolicy: 'recommended';
    configured: boolean;
    traditionalImapAvailableInInboxora: true;
  };
}

function microsoftReadiness(stored: ProviderConfig): IntegrationStatus['microsoft'] {
  const clientId = process.env.MS_CLIENT_ID;
  const missing: string[] = [];
  if (!clientId) missing.push('clientId');
  if (!process.env.MS_CLIENT_SECRET) missing.push('clientSecret');
  if (!process.env.MS_REDIRECT_URI) missing.push('redirectUri');
  // Device authorization needs only a registered client: no redirect URI and no
  // client secret. The saved row's explicit device disable is honoured.
  const deviceReady = !!clientId && stored.deviceEnabled !== false;
  // The connector authorizes on its own callback, which is derived from APP_URL when
  // MS_PROVIDER_REDIRECT_URI is unset. Reporting it separately is what lets the card
  // offer the connector where the mailbox sign-in is not configured, and only there.
  const config = microsoftConfigFromEnv();
  const graphMissing: string[] = [];
  if (!config.clientId) graphMissing.push('clientId');
  if (!config.clientSecret) graphMissing.push('clientSecret');
  if (!config.providerRedirectUri) graphMissing.push('providerRedirectUri');
  return {
    configured: !!clientId,
    // A provider the administrator switched off is reported as not enabled, so the card stops
    // offering it at the same moment the flow stops accepting it.
    enabled: providerIntegrationsEnabled() && !!clientId && stored.disabled !== true,
    browser: { ready: providerIntegrationsEnabled() && missing.length === 0 && stored.webEnabled !== false && stored.disabled !== true, missing },
    graph: { ready: graphMissing.length === 0, missing: graphMissing },
    deviceCode: {
      supported: true,
      ready: providerIntegrationsEnabled() && deviceReady && stored.disabled !== true,
      ...(deviceReady ? {} : { reason: clientId ? 'device_disabled' : 'missing_client_id' }),
    },
    mailPolicy: 'required',
  };
}

function googleReadiness(stored: ProviderConfig): IntegrationStatus['google'] {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const missing: string[] = [];
  if (!clientId) missing.push('clientId');
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('clientSecret');
  if (!process.env.GOOGLE_REDIRECT_URI) missing.push('redirectUri');
  return {
    configured: !!clientId,
    enabled: providerIntegrationsEnabled() && !!clientId && stored.disabled !== true,
    // The operator's API switch is part of readiness, so the card stops offering the
    // connector at the same moment the flow stops accepting it.
    browser: { ready: providerIntegrationsEnabled() && missing.length === 0 && stored.disabled !== true && stored.apiEnabled !== false, missing },
    // Google's limited-input device flow does not allow the Gmail, Calendar or
    // People scopes this integration needs, so it is never offered.
    deviceCode: { supported: false, ready: false, reason: 'not_supported' },
    mailPolicy: 'recommended',
    traditionalImapAvailableInInboxora: true,
  };
}

/**
 * Validate an untrusted payload against the provider's closed schema. Unknown
 * providers, unknown fields, wrong types and oversized values are rejected
 * before anything is written — the body never becomes an arbitrary env entry.
 */
export function validateProviderConfig(provider: ProviderName, body: unknown):
  | { ok: true; config: ProviderConfig; clearSecret: boolean }
  | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Configuration must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS[provider].includes(key)) {
      return { ok: false, error: `Unknown field for ${provider}: ${key}` };
    }
  }
  for (const field of STRING_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
    const limit = field === 'clientSecret' ? MAX_SECRET : MAX_STRING;
    if (value.length > limit) return { ok: false, error: `${field} is too long` };
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
  }

  const config: ProviderConfig = {};
  const setString = (field: 'clientId' | 'redirectUri' | 'tenantId'): void => {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) config[field] = value;
  };
  setString('clientId');
  setString('redirectUri');
  if (provider === 'microsoft') {
    setString('tenantId');
    if (typeof record.webEnabled === 'boolean') config.webEnabled = record.webEnabled;
    if (typeof record.deviceEnabled === 'boolean') config.deviceEnabled = record.deviceEnabled;
  } else if (typeof record.apiEnabled === 'boolean') {
    config.apiEnabled = record.apiEnabled;
  }
  // Saving a configuration enables the provider unless the caller explicitly
  // disables it; a previous tombstone must not survive a normal save.
  config.disabled = record.enabled === false;

  return { ok: true, config: { ...config }, clearSecret: record.clientSecretClear === true };
}

/** Merge a validated payload over the stored row, preserving an untouched secret. */
function mergeConfig(existing: ProviderConfig, incoming: ProviderConfig, rawSecret: unknown, clearSecret: boolean): ProviderConfig {
  const merged: ProviderConfig = { ...incoming };
  if (clearSecret) {
    // Explicit clear: no secret is stored.
  } else if (typeof rawSecret === 'string' && rawSecret && rawSecret !== SECRET_SENTINEL) {
    merged.clientSecret = isEncrypted(rawSecret) ? rawSecret : encrypt(rawSecret);
  } else if (typeof existing.clientSecret === 'string' && existing.clientSecret) {
    merged.clientSecret = existing.clientSecret;
  }
  if (incoming.disabled) merged.disabledAt = new Date().toISOString();
  return merged;
}

async function readStoredConfig(provider: ProviderName): Promise<ProviderConfig> {
  const result = await query<{ config: ProviderConfig }>('SELECT config FROM integration_config WHERE provider = $1', [provider]);
  return result.rows[0]?.config ?? {};
}

function publicConfig(config: ProviderConfig): ProviderConfig {
  const masked: ProviderConfig = { ...config };
  if (masked.clientSecret) masked.clientSecret = SECRET_SENTINEL;
  delete masked.disabledAt;
  return masked;
}

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
// Verify the stored client credentials against the provider. Readiness reports that the fields are present;
// this reports whether the provider accepts them, which is the difference between a configured method and a
// working one — a mistyped secret otherwise reads as ready until an authorization fails at the provider.
router.post('/:provider/test', requireAdmin, async (req: Request, res: Response) => {
  const provider = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  if (!isProviderName(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const stored = await readStoredConfig(provider);
  if (!stored.clientId) {
    return res.status(409).json({ ok: false, code: 'ADMIN_CONFIGURATION_REQUIRED', error: 'No client id is saved for this provider' });
  }
  // Only the id and secret are used, and the secret never leaves the server: it is decrypted for the call and
  // is not part of the answer. No user data and no user grant are involved.
  const secret = typeof stored.clientSecret === 'string' && stored.clientSecret ? decrypt(stored.clientSecret) : null;
  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${encodeURIComponent(stored.tenantId || 'common')}/oauth2/v2.0/token`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        // A deliberately unusable grant. The provider answers `invalid_client` when the credentials are wrong
        // and something else — `invalid_grant` usually — when they are accepted; that distinction is the whole
        // test, and it costs the provider nothing.
        grant_type: 'authorization_code',
        code: 'inboxora-configuration-test',
        client_id: stored.clientId,
        ...(secret ? { client_secret: secret } : {}),
        ...(stored.redirectUri ? { redirect_uri: stored.redirectUri } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await response.json()) as { error?: string; error_description?: string };
    const code = typeof body.error === 'string' ? body.error : null;
    const credentialsAccepted = code !== 'invalid_client' && code !== 'unauthorized_client';
    res.json({ ok: credentialsAccepted, code: credentialsAccepted ? 'CREDENTIALS_ACCEPTED' : (code ?? 'INVALID_CLIENT') });
  } catch (caught) {
    console.error('Provider configuration test failed:', toAppError(caught).message);
    res.status(502).json({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
  }
});

// Disconnect a provider account the signed-in user connected. Deliberately not admin-only:
// the connection is theirs, and needing an administrator to undo an authorization would make
// the consent weaker than it looks. Nothing imported is deleted — see the service.
router.post('/provider-connections/:id/disconnect', async (req: Request, res: Response) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    // Express types a route parameter as string | string[]; a single segment is a string.
    const connectionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await disconnectProviderConnection(userId, connectionId);
    if (!result) return res.status(404).json({ error: 'Connection not found' });
    res.json(result);
  } catch (caught) {
    console.error('Provider disconnect failed:', toAppError(caught).message);
    res.status(500).json({ error: 'Failed to disconnect the provider account' });
  }
});

/**
 * Enable or disable write-back for one pulled collection (P07d/P09).
 *
 * Pulled collections are read-only, and learning to write one must not change that silently: this is the
 * user's explicit opt-in, and it is the **only** thing that sets `user_access = 'read_write'`. Two gates
 * still apply after it, and neither can be overridden here:
 *
 *  - the source must permit writes at all (`source_access`), which the sync recorded from the provider's
 *    own answer — a calendar Microsoft marks `canEdit: false` is refused with a reason; and
 *  - the adapter must actually forward the mutation, which the capability model reads from the registry.
 *
 * For a calendar the local `read_only` column mirrors the choice, because that is what the interface
 * reads; an address book has no such column and is judged by the collection alone.
 */
router.patch('/collections/:id', async (req: Request, res: Response) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  if (typeof req.body?.writeBack !== 'boolean') return res.status(400).json({ error: 'writeBack must be a boolean' });
  const enable = req.body.writeBack as boolean;

  const result = await query<{
    id: string; kind: string; source: string | null; source_access: string; user_access: string;
    local_calendar_id: string | null; local_address_book_id: string | null;
  }>(
    `SELECT ic.id, ic.kind, ic.source_access, ic.user_access,
            ic.local_calendar_id, ic.local_address_book_id,
            COALESCE(c.source, ab.source) AS source
       FROM integration_collections ic
       LEFT JOIN calendars c ON c.id = ic.local_calendar_id
       LEFT JOIN address_books ab ON ab.id = ic.local_address_book_id
      WHERE ic.id = $1 AND ic.user_id = $2`,
    [Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, userId],
  );
  const collection = result.rows[0];
  if (!collection) return res.status(404).json({ error: 'Collection not found' });
  if (enable && collection.source_access !== 'read_write') {
    return res.status(409).json({
      code: 'SOURCE_READ_ONLY',
      error: 'The provider does not allow changes to this collection',
    });
  }
  // The adapter must actually forward this kind of write. Passing the opted-in values isolates the
  // registry and conflict-protection layers, so this answers "does a write path exist at all?" rather
  // than repeating the collection's own gate.
  if (enable) {
    const feature = collection.kind === 'calendar' ? 'calendars'
      : collection.kind === 'address_book' ? 'contacts'
        : null;
    if (!feature || !collectionIsWritable({
      source: collection.source,
      source_access: 'read_write',
      user_access: 'read_write',
    }, feature)) {
      return res.status(409).json({
        code: 'WRITE_PATH_UNAVAILABLE',
        error: 'Writing this kind of collection back to its source is not available yet',
      });
    }
  }

  const userAccess = enable ? 'read_write' : 'source';
  await query('UPDATE integration_collections SET user_access = $2, updated_at = NOW() WHERE id = $1', [collection.id, userAccess]);
  if (collection.local_calendar_id) {
    // The calendar list reports this flag, so it is kept in step rather than recomputed per request.
    await query('UPDATE calendars SET read_only = $2, updated_at = NOW() WHERE id = $1 AND user_id = $3', [
      collection.local_calendar_id, !enable, userId,
    ]);
  }

  res.json({
    collection: {
      id: collection.id,
      kind: collection.kind,
      sourceAccess: collection.source_access,
      userAccess,
      writeBack: enable,
    },
  });
});

/**
 * The active Google mail migration recommendation for the caller's own accounts (P09).
 *
 * Authenticated, never admin-only: the notice is about the caller's own mailbox. Only the account id,
 * its address and the notice type cross the wire — the wording, the migration link and what "ignore"
 * means are the interface's, so the copy can change without a server release.
 *
 * The Microsoft requirement notice is deliberately absent from this endpoint. It is a requirement, not
 * a recommendation, and `account_notice_preferences` has no notice type for it, so there is nothing
 * here that could suppress it. That must stay true.
 */
router.get('/notices', async (req: Request, res: Response) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const notices = await listActiveGoogleMailRecommendations(userId);
    res.json({ notices });
  } catch (caught) {
    console.error('Listing account notices failed:', toAppError(caught).message);
    res.status(500).json({ error: 'Failed to load account notices' });
  }
});

/**
 * "Do not show again" for one account's recommendation.
 *
 * This is the durable, server-side suppression; "ignore" remains a client-side dismissal. Ownership is
 * enforced in the service, so another user's account id answers `404`.
 */
router.post('/notices/:accountId/suppress', async (req: Request, res: Response) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await suppressGoogleMailRecommendation(userId, routeParam(req.params.accountId));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (caught) {
    console.error('Suppressing an account notice failed:', toAppError(caught).message);
    res.status(500).json({ error: 'Failed to save the notice preference' });
  }
});

router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  const result = await query<{ provider: string; config: ProviderConfig; updated_at: string | Date | null }>(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  const configs: Record<string, Record<string, unknown>> = {};
  for (const row of result.rows) {
    if (!isProviderName(row.provider)) continue;
    configs[row.provider] = { ...publicConfig(row.config), updated_at: row.updated_at };
  }
  res.json(configs);
});

// Capability check for any authenticated user (non-admins included). Reports only
// readiness per method — never a client ID, a secret or another account's data.
router.get('/status', async (req: Request, res: Response) => {
  const userId = req.session?.userId;
  const [microsoftStored, googleStored, connections] = await Promise.all([
    readStoredConfig('microsoft'),
    readStoredConfig('google'),
    // Owner-scoped: a user sees their own connections, never another's.
    userId
      ? query<{ id: string; provider: string; provider_user_id: string | null; status: string }>(
        `SELECT id, provider, provider_user_id, status FROM provider_connections
          WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      )
      : Promise.resolve({ rows: [] as Array<{ id: string; provider: string; provider_user_id: string | null; status: string }> }),
  ]);
  const forProvider = (provider: string) => connections.rows
    .filter(row => row.provider === provider)
    .map(row => ({ id: row.id, providerUserId: row.provider_user_id, status: row.status }));
  const status: IntegrationStatus = {
    microsoft: { ...microsoftReadiness(microsoftStored), connections: forProvider('microsoft') },
    google: { ...googleReadiness(googleStored), connections: forProvider('google') },
  };
  res.json(status);
});

/**
 * Instant-synchronisation status: what push needs, what is registered, and how it is doing.
 *
 * Administrator-level detail with no secrets in it: the callback URLs (derived from `APP_URL`, never typed
 * per account), whether each provider's push is available and why not, the live subscriptions with their
 * expiries and last notification, and how many hints are waiting. An installation without a public HTTPS URL
 * reads as "not configured" here and keeps synchronising by polling — which is a state, not an error.
 */
router.get('/push-status', requireAdmin, async (_req: Request, res: Response) => {
  const availability = pushAvailability();
  const microsoft = microsoftPushAvailable();
  const calendarPush = googleCalendarPushAvailable();
  const gmail = gmailPushAvailable();
  const [subscriptions, hints] = await Promise.all([listSubscriptionDiagnostics(), syncHintDiagnostics()]);
  res.json({
    enabled: availability.enabled,
    webhookBaseUrl: availability.webhookBaseUrl,
    reason: availability.reason,
    endpoints: {
      microsoft: publicWebhookUrl('/api/provider-webhooks/microsoft'),
      gmail: publicWebhookUrl('/api/provider-webhooks/gmail'),
      googleCalendar: publicWebhookUrl('/api/provider-webhooks/google-calendar'),
    },
    microsoft: {
      available: microsoft.available,
      reason: microsoft.reason,
      resources: ['mail', 'calendar', 'contacts'],
    },
    google: {
      gmailAvailable: gmail.available,
      gmailReason: gmail.reason,
      calendarAvailable: calendarPush.available,
      calendarReason: calendarPush.reason,
      // The People API has no push channel for the resources Inboxora syncs, so contacts stay on their sync
      // token and the schedule. Documented rather than faked.
      contacts: { push: false, strategy: 'polling' },
    },
    pollingFallback: { enabled: true, intervalMinutes: providerSyncIntervalMinutes() },
    subscriptions,
    hints,
  });
});

/**
 * Register (or refresh) the push subscriptions of one connection.
 *
 * Deliberate and per connection: the user or administrator asks for instant synchronisation of a mailbox or
 * its calendars, and Inboxora registers exactly the resources that connection has pulled. A refusal from the
 * provider is reported per resource; polling is unaffected either way.
 */
router.post('/push/connections/:id/enable', requireAdmin, async (req: Request, res: Response) => {
  const connectionId = routeParam(req.params.id);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });
  const connection = await query<{ id: string; user_id: string; provider: string }>(
    'SELECT id, user_id, provider FROM provider_connections WHERE id = $1 AND status = $2',
    [connectionId, 'active'],
  );
  const target = connection.rows[0];
  if (!target) return res.status(404).json({ error: 'Connection not found' });

  const collections = await query<{ id: string; kind: string; remote_id: string | null; local_calendar_id: string | null }>(
    `SELECT id, kind, remote_id, local_calendar_id FROM integration_collections
      WHERE connection_id = $1 AND enabled = true`,
    [connectionId],
  );
  const kinds = new Set(collections.rows.map(row => row.kind));

  try {
    if (target.provider === 'microsoft') {
      const resourceTypes: Array<'mail' | 'calendar' | 'contacts'> = [];
      if (kinds.has('mail_folder')) resourceTypes.push('mail');
      if (kinds.has('calendar')) resourceTypes.push('calendar');
      if (kinds.has('address_book')) resourceTypes.push('contacts');
      if (!resourceTypes.length) return res.status(409).json({ error: 'This connection has no pulled collections to watch', code: 'NO_COLLECTIONS' });
      const outcome = await ensureGraphSubscriptions({ userId: target.user_id, connectionId, resourceTypes });
      return res.json({ ok: true, provider: 'microsoft', created: outcome.created, failed: outcome.failed });
    }
    if (target.provider === 'google') {
      const calendars = collections.rows
        .filter(row => row.kind === 'calendar' && row.remote_id)
        .map(row => ({ collectionId: row.id, remoteCalendarId: String(row.remote_id) }));
      const outcome = await ensureGoogleSubscriptions({
        userId: target.user_id,
        connectionId,
        calendars,
        includeMail: kinds.has('mail_folder'),
      });
      return res.json({ ok: true, provider: 'google', created: outcome.created, failed: outcome.failed });
    }
    return res.status(400).json({ error: 'Unknown provider' });
  } catch (caught) {
    const error = toAppError(caught);
    console.error('Push subscription setup failed:', error.message);
    return res.status(502).json({ error: 'The provider refused the notification setup', code: error.code ?? 'PUSH_SETUP_FAILED' });
  }
});

/** Stop and tombstone the push subscriptions of one connection, without touching the connection itself. */
router.post('/push/connections/:id/disable', requireAdmin, async (req: Request, res: Response) => {
  const connectionId = routeParam(req.params.id);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });
  const connection = await query<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM provider_connections WHERE id = $1',
    [connectionId],
  );
  const target = connection.rows[0];
  if (!target) return res.status(404).json({ error: 'Connection not found' });
  const outcome = await releaseProviderPushForConnection({ userId: target.user_id, connectionId });
  res.json({ ok: true, ...outcome });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req: Request, res: Response) => {
  const provider = routeParam(req.params.provider);
  if (!isProviderName(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const validation = validateProviderConfig(provider, req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const { config: incoming, clearSecret } = validation;

  const existing = await readStoredConfig(provider);
  const merged = mergeConfig(existing, incoming, (req.body as Record<string, unknown>).clientSecret, clearSecret);

  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, merged]);

  applyProviderConfig(provider, merged);

  res.json({ ok: true });
});

// Delete integration config — admin only. Deleting writes a tombstone so a
// restart cannot silently restore the previous `.env` configuration.
router.delete('/:provider', requireAdmin, async (req: Request, res: Response) => {
  const provider = routeParam(req.params.provider);
  if (!isProviderName(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const tombstone: ProviderConfig = { disabled: true, disabledAt: new Date().toISOString() };
  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, tombstone]);

  clearProviderEnv(provider);
  res.json({ ok: true });
});
// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query<{ provider: string; config: ProviderConfig }>('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      if (!isProviderName(row.provider)) continue;
      if (row.config?.disabled) {
        clearProviderEnv(row.provider);
        continue;
      }
      applyProviderConfig(row.provider, row.config);
    }
    console.log('Integration configs loaded');
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
