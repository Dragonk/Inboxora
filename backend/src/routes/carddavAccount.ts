// CardDAV *client* account management: connect/disconnect a remote CardDAV
// server (e.g. Nextcloud) whose contacts are pulled into MailFlow. Credentials
// live in user_integrations (provider='carddav'), password encrypted. This is
// distinct from routes/carddav.js, which is the CardDAV *server* MailFlow exposes.

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { discoverAddressBooks } from '../services/carddavClient.js';
import { syncUser, scheduleCardavUser, stopCardavUser, getCardavConfig, listCardavConfigs } from '../services/carddavSync.js';
import { sessionUserId } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';

const router = Router();
router.use(requireAuth);

type DuplicateMode = 'separate' | 'merge' | 'skip';

type CarddavConfig = {
  serverUrl?: string | null;
  username?: string | null;
  password?: string | null;
  dupMode?: string | null;
  intervalMin?: number | null;
  lastSyncAt?: unknown;
  lastError?: unknown;
  bookCount?: unknown;
  contactCount?: unknown;
};

type CarddavConnectedConfig = CarddavConfig & {
  serverUrl: string;
  username: string;
  password: string;
  dupMode: DuplicateMode;
  intervalMin: number;
};

type CarddavConfigPatch = {
  dupMode?: DuplicateMode;
  intervalMin?: number;
  password?: string;
};

function requestBody(req: Request): Record<string, unknown> | null {
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return null;
  return req.body;
}

function duplicateMode(value: unknown): DuplicateMode | null {
  if (value === 'separate' || value === 'merge' || value === 'skip') return value;
  return null;
}

function clampInterval(value: unknown): number {
  const parsed = typeof value === 'string' || typeof value === 'number'
    ? Number.parseInt(String(value), 10)
    : Number.NaN;
  const normalized = Number.isNaN(parsed) || parsed === 0 ? 60 : parsed;
  return Math.max(15, Math.min(1440, normalized));
}

// Public view of the connection — never leaks the stored password.
function publicStatus(config: CarddavConfig | null, source?: { id: string; label: string | null }) {
  if (config === null || !config.serverUrl) return { connected: false, ...(source ? { id: source.id, label: source.label } : {}) };
  return {
    connected: true,
    ...(source ? { id: source.id, label: source.label } : {}),
    serverUrl: config.serverUrl,
    username: config.username,
    dupMode: config.dupMode || 'separate',
    intervalMin: config.intervalMin || 60,
    lastSyncAt: config.lastSyncAt || null,
    lastError: config.lastError || null,
    bookCount: config.bookCount ?? null,
    contactCount: config.contactCount ?? null,
  };
}

router.get('/', async (req: Request, res: Response) => {
  const sources = await listCardavConfigs(sessionUserId(req));
  const primary = sources[0] ?? null;
  res.json({
    ...publicStatus(primary?.config ?? null, primary ? { id: primary.id, label: primary.label } : undefined),
    // Source-aware clients use this list; legacy clients continue reading the top-level status fields above.
    sources: sources.map(source => publicStatus(source.config, { id: source.id, label: source.label })),
  });
});

router.post('/connect', async (req: Request, res: Response) => {
  const body = requestBody(req);
  if (body === null) return res.status(400).json({ error: 'Server URL, username, and password are required' });
  const { serverUrl, username, password, dupMode, intervalMin, label: requestedLabel } = body;
  const label = typeof requestedLabel === 'string' && requestedLabel.trim() ? requestedLabel.trim() : null;
  if (typeof serverUrl !== 'string' || !serverUrl || typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Server URL, username, and password are required' });
  }
  let parsed: URL;
  try { parsed = new URL(serverUrl); }
  catch { return res.status(400).json({ error: 'Invalid server URL' }); }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'Server URL must be http(s).' });
  }

  const policy = await getConnectionPolicy();
  // Require HTTPS so Basic-auth credentials aren't sent in the clear. Plaintext HTTP is
  // permitted ONLY for a genuinely private/local address, and only when the admin has
  // enabled private hosts — never to a public host (which would leak credentials).
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) {
      return res.status(400).json({ error: 'Server URL must use HTTPS.' });
    }
    const publicErr = await validateHost(parsed.hostname, { allowPrivate: false });
    if (!publicErr) { // resolves to a public address
      return res.status(400).json({ error: 'HTTPS is required for a public host; plaintext HTTP is only allowed for a private/local address.' });
    }
  }
  const hostErr = await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
  if (hostErr) return res.status(400).json({ error: hostErr });

  // Verify credentials + reachability before storing anything.
  try {
    await discoverAddressBooks({ serverUrl, username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (caught) {
    const err = toAppError(caught);
    return res.status(400).json({ error: err.message });
  }

  const selectedDupMode = duplicateMode(dupMode);
  const config: CarddavConnectedConfig = {
    serverUrl,
    username,
    password: encrypt(password),
    dupMode: selectedDupMode === null ? 'separate' : selectedDupMode,
    intervalMin: clampInterval(intervalMin),
    lastError: null,
  };
  const stored = await query<{ id: string }>(
    label
      ? `INSERT INTO user_integrations (user_id, provider, config, label)
         VALUES ($1, 'carddav', $2::jsonb, $3)
         ON CONFLICT (user_id, provider, label) WHERE label IS NOT NULL
         DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
         RETURNING id`
      : `INSERT INTO user_integrations (user_id, provider, config, label)
         VALUES ($1, 'carddav', $2::jsonb, NULL)
         ON CONFLICT (user_id, provider) WHERE label IS NULL
         DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
         RETURNING id`,
    label ? [sessionUserId(req), JSON.stringify(config), label] : [sessionUserId(req), JSON.stringify(config)],
  );

  const userId = sessionUserId(req);
  const sourceId = stored.rows[0]?.id ?? null;
  scheduleCardavUser(userId, config.intervalMin, sourceId);
  // Kick off the first sync in the background; the client polls GET / for status.
  syncUser(userId, sourceId).catch(() => {});
  res.json(publicStatus(config, sourceId ? { id: sourceId, label } : undefined));
});

// Update duplicate handling / interval (and optionally rotate the password).
router.patch('/', async (req: Request, res: Response) => {
  const body = requestBody(req);
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : null;
  const existing = await getCardavConfig(sessionUserId(req), sourceId);
  if (existing === null || !existing.serverUrl) return res.status(409).json({ error: 'CardDAV source not connected' });

  if (body === null) return res.status(400).json({ error: 'Invalid request body' });
  const patch: CarddavConfigPatch = {};
  const selectedDupMode = duplicateMode(body.dupMode);
  if (selectedDupMode !== null) patch.dupMode = selectedDupMode;
  if (body.intervalMin !== null && body.intervalMin !== undefined) patch.intervalMin = clampInterval(body.intervalMin);
  if (typeof body.password === 'string' && body.password) patch.password = encrypt(body.password);

  await query(
    sourceId
      ? `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
         WHERE id = $1 AND user_id = $3 AND provider = 'carddav'`
      : `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
         WHERE user_id = $1 AND provider = 'carddav' AND label IS NULL`,
    sourceId ? [sourceId, JSON.stringify(patch), sessionUserId(req)] : [sessionUserId(req), JSON.stringify(patch)],
  );
  if (patch.intervalMin) {
    const sourceRows = await listCardavConfigs(sessionUserId(req));
    const selected = sourceId ? sourceRows.find(row => row.id === sourceId) : sourceRows.find(row => row.label === null);
    scheduleCardavUser(sessionUserId(req), patch.intervalMin, selected?.id ?? sourceId);
  }
  res.json(publicStatus({ ...existing, ...patch }));
});

router.post('/sync', async (req: Request, res: Response) => {
  const userId = sessionUserId(req);
  const requestedSource = requestBody(req);
  const sourceId = typeof requestedSource?.sourceId === 'string' ? requestedSource.sourceId : null;
  const config = await getCardavConfig(userId, sourceId);
  if (config === null || !config.serverUrl) return res.status(409).json({ error: 'CardDAV source not connected' });
  const result = await syncUser(userId, sourceId);
  const sources = await listCardavConfigs(userId);
  const selected = sourceId ? sources.find(source => source.id === sourceId) : sources[0];
  res.json({ ...result, status: publicStatus(selected?.config ?? null, selected ? { id: selected.id, label: selected.label } : undefined), sources: sources.map(source => publicStatus(source.config, { id: source.id, label: source.label })) });
});

router.delete('/', async (req: Request, res: Response) => {
  const userId = sessionUserId(req);
  const body = requestBody(req);
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : null;
  const source = await getCardavConfig(userId, sourceId);
  if (!source) return res.status(404).json({ error: 'CardDAV source not connected' });
  const sourceRows = await listCardavConfigs(userId);
  const selectedSourceId = sourceId ?? sourceRows.find(row => row.label === null)?.id ?? null;
  stopCardavUser(selectedSourceId ?? `legacy:${userId}`);
  // Remove only books linked to the selected source; contacts cascade with them.
  await query(
    `DELETE FROM address_books ab
      WHERE ab.user_id = $1 AND ab.source = 'carddav'
        AND EXISTS (
          SELECT 1 FROM integration_collections ic
          JOIN source_connections sc ON sc.id = ic.source_connection_id
          WHERE ic.local_address_book_id = ab.id AND sc.integration_id = $2
        )`,
    [userId, selectedSourceId],
  );
  await query(
    selectedSourceId
      ? "DELETE FROM user_integrations WHERE id = $1 AND user_id = $2 AND provider = 'carddav'"
      : "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'carddav' AND label IS NULL",
    selectedSourceId ? [selectedSourceId, userId] : [userId],
  );
  res.json({ ok: true });
});

export default router;
