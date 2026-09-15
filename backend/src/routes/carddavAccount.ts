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
import { syncUser, scheduleCardavUser, stopCardavUser, getCardavConfig } from '../services/carddavSync.js';
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
function publicStatus(config: CarddavConfig | null) {
  if (config === null || !config.serverUrl) return { connected: false };
  return {
    connected: true,
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
  res.json(publicStatus(await getCardavConfig(sessionUserId(req))));
});

router.post('/connect', async (req: Request, res: Response) => {
  const body = requestBody(req);
  if (body === null) return res.status(400).json({ error: 'Server URL, username, and password are required' });
  const { serverUrl, username, password, dupMode, intervalMin } = body;
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
  await query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', $2::jsonb)
     ON CONFLICT (user_id, provider) DO UPDATE SET config = $2::jsonb, updated_at = NOW()`,
    [sessionUserId(req), JSON.stringify(config)],
  );

  const userId = sessionUserId(req);
  scheduleCardavUser(userId, config.intervalMin);
  // Kick off the first sync in the background; the client polls GET / for status.
  syncUser(userId).catch(() => {});
  res.json(publicStatus(config));
});

// Update duplicate handling / interval (and optionally rotate the password).
router.patch('/', async (req: Request, res: Response) => {
  const existing = await getCardavConfig(sessionUserId(req));
  if (existing === null || !existing.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });

  const body = requestBody(req);
  if (body === null) return res.status(400).json({ error: 'Invalid request body' });
  const patch: CarddavConfigPatch = {};
  const selectedDupMode = duplicateMode(body.dupMode);
  if (selectedDupMode !== null) patch.dupMode = selectedDupMode;
  if (body.intervalMin !== null && body.intervalMin !== undefined) patch.intervalMin = clampInterval(body.intervalMin);
  if (typeof body.password === 'string' && body.password) patch.password = encrypt(body.password);

  await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'`,
    [sessionUserId(req), JSON.stringify(patch)],
  );
  if (patch.intervalMin) scheduleCardavUser(sessionUserId(req), patch.intervalMin);
  res.json(publicStatus({ ...existing, ...patch }));
});

router.post('/sync', async (req: Request, res: Response) => {
  const userId = sessionUserId(req);
  const config = await getCardavConfig(userId);
  if (config === null || !config.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });
  const result = await syncUser(userId);
  res.json({ ...result, status: publicStatus(await getCardavConfig(userId)) });
});

router.delete('/', async (req: Request, res: Response) => {
  const userId = sessionUserId(req);
  stopCardavUser(userId);
  // Remove the synced (read-only) address books; contacts cascade with them.
  await query(
    "DELETE FROM address_books WHERE user_id = $1 AND source = 'carddav'",
    [userId],
  );
  await query(
    "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [userId],
  );
  res.json({ ok: true });
});

export default router;
