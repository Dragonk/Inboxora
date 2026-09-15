import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import { routeParam } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';

const router = Router();
router.use(requireAuth);

type MicrosoftConfig = { clientId?: unknown; clientSecret?: unknown; tenantId?: unknown; redirectUri?: unknown };

// An absent field leaves the process-level fallback untouched; an explicit empty
// string is a deliberate clear and must not leave a stale credential in memory.
function applyMicrosoftConfig(config: MicrosoftConfig) {
  const apply = (envKey: 'MS_CLIENT_ID' | 'MS_TENANT_ID' | 'MS_REDIRECT_URI', value: unknown) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || !value) delete process.env[envKey];
    else process.env[envKey] = value;
  };
  apply('MS_CLIENT_ID', config.clientId);
  apply('MS_TENANT_ID', config.tenantId);
  apply('MS_REDIRECT_URI', config.redirectUri);
  if (config.clientSecret !== undefined) {
    if (typeof config.clientSecret !== 'string' || !config.clientSecret) delete process.env.MS_CLIENT_SECRET;
    else {
      const secret = decrypt(config.clientSecret);
      if (secret === null || !secret) delete process.env.MS_CLIENT_SECRET;
      else process.env.MS_CLIENT_SECRET = secret;
    }
  }
}

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  const result = await query<{ provider: string; config: Record<string, unknown>; updated_at: string | Date | null }>(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  // Redact secrets from response
  const configs: Record<string, Record<string, unknown>> = {};
  for (const row of result.rows) {
    const cfg = { ...row.config };
    if (cfg.clientSecret) cfg.clientSecret = '••••••••';
    configs[row.provider] = { ...cfg, updated_at: row.updated_at };
  }
  res.json(configs);
});

// Capability check for any authenticated user (non-admins included). Reports only
// whether each provider is configured — never the client ID, secret, or any other
// credential. This lets a non-admin see that Microsoft OAuth is available and enable
// the connect buttons, while the config read/write/delete endpoints stay admin-only.
// The OAuth connect routes already require only an authenticated session and bind the
// resulting mailbox to that user, so no privilege is granted here. (#315)
router.get('/status', async (req: Request, res: Response) => {
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
  });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req: Request, res: Response) => {
  const provider = routeParam(req.params.provider);
  const allowed = ['microsoft'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const config = req.body;

  // If clientSecret is redacted, keep the existing stored value (already encrypted or legacy plaintext)
  if (config.clientSecret === '••••••••') {
    const existing = await query<{ config: { clientId?: string; clientSecret?: string; tenantId?: string; redirectUri?: string; [key: string]: unknown } }>(
      'SELECT config FROM integration_config WHERE provider = $1',
      [provider]
    );
    if (existing.rows.length) {
      config.clientSecret = existing.rows[0].config.clientSecret;
    } else {
      delete config.clientSecret;
    }
  }

  // Encrypt clientSecret at rest — handles both new writes and migration of legacy plaintext values
  if (config.clientSecret && !isEncrypted(config.clientSecret)) {
    config.clientSecret = encrypt(config.clientSecret);
  }

  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, config]);

  // Apply the exact saved configuration immediately, including explicit clears.
  if (provider === 'microsoft') applyMicrosoftConfig(config);

  res.json({ ok: true });
});

// Delete integration config — admin only
router.delete('/:provider', requireAdmin, async (req: Request, res: Response) => {
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  if (req.params.provider === 'microsoft') {
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_REDIRECT_URI;
  }
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query<{ provider: string; config: { clientId?: string; clientSecret?: string; tenantId?: string; redirectUri?: string; [key: string]: unknown } }>('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      if (row.provider === 'microsoft') applyMicrosoftConfig(row.config);
    }
    console.log('Integration configs loaded');
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
