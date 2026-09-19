import { Router } from 'express';
import { disconnectProviderConnection } from '../services/providerConnectionService.js';
import { microsoftConfigFromEnv } from '../services/providerAuthService.js';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import { routeParam } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';

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
    enabled: !!clientId && stored.disabled !== true,
    browser: { ready: missing.length === 0 && stored.webEnabled !== false && stored.disabled !== true, missing },
    graph: { ready: graphMissing.length === 0, missing: graphMissing },
    deviceCode: {
      supported: true,
      ready: deviceReady && stored.disabled !== true,
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
    enabled: !!clientId && stored.disabled !== true,
    // The operator's API switch is part of readiness, so the card stops offering the
    // connector at the same moment the flow stops accepting it.
    browser: { ready: missing.length === 0 && stored.disabled !== true && stored.apiEnabled !== false, missing },
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
