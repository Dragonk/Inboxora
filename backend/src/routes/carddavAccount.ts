// CardDAV *client* account management: connect/disconnect a remote CardDAV
// server (e.g. Nextcloud) whose contacts are pulled into MailFlow. Credentials
// live in user_integrations (provider='carddav'), password encrypted. This is
// distinct from routes/carddav.js, which is the CardDAV *server* MailFlow exposes.

import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
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
  if (body === null) return res.status(400).json({ error: 'Invalid request body' });
  const userId = sessionUserId(req);
  const requestedId = typeof body.sourceId === 'string' ? body.sourceId : null;
  const sources = await listCardavConfigs(userId);
  const source = requestedId ? sources.find(row => row.id === requestedId) : sources.find(row => row.label === null);
  if (!source) return res.status(404).json({ code: 'SOURCE_NOT_AVAILABLE', error: 'CardDAV source not found' });
  const existing = await getCardavConfig(userId, source.id);
  if (!existing?.serverUrl) return res.status(409).json({ error: 'CardDAV source not connected' });
  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');
  const label = typeof body.label === 'string' ? body.label.trim() : null;
  if (hasLabel && (!label || label.length > 120)) return res.status(400).json({ code: 'INVALID_SOURCE_NAME', error: 'Invalid source name' });
  const patch: CarddavConfigPatch = {};
  const selectedDupMode = duplicateMode(body.dupMode);
  if (selectedDupMode !== null) patch.dupMode = selectedDupMode;
  if (body.intervalMin !== null && body.intervalMin !== undefined) {
    const minutes = Number(body.intervalMin);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) return res.status(400).json({ error: 'Invalid sync interval' });
    patch.intervalMin = minutes;
  }
  if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 4096)) return res.status(400).json({ error: 'Invalid password' });
  if (typeof body.password === 'string' && body.password) patch.password = encrypt(body.password);
  try {
    await query(`UPDATE user_integrations SET config = config || $2::jsonb,
      label = CASE WHEN $4::boolean THEN $5::text ELSE label END, updated_at = NOW()
      WHERE id = $1 AND user_id = $3 AND provider = 'carddav'`, [source.id, JSON.stringify(patch), userId, hasLabel, label]);
  } catch (caught) {
    if (toAppError(caught).code === '23505') return res.status(409).json({ code: 'SOURCE_NAME_EXISTS', error: 'Source name already exists' });
    throw caught;
  }
  if (patch.intervalMin) scheduleCardavUser(userId, patch.intervalMin, source.id);
  res.json(publicStatus({ ...existing, ...patch }, { id: source.id, label: hasLabel ? label : source.label }));
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

// Forget an orphaned legacy CardDAV projection locally.
//
// Current CardDAV sources are owned by user_integrations and continue to use
// DELETE /carddav. Older projections may survive without that integration row.
// This endpoint only removes Inboxora's local projection and never contacts the
// remote CardDAV server.
router.delete('/legacy/:sourceIdentity', async (req: Request, res: Response) => {
  const userId = sessionUserId(req);
  const identity = Array.isArray(req.params.sourceIdentity)
    ? req.params.sourceIdentity[0]
    : req.params.sourceIdentity;

  const match = /^carddav:(connection|book):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(identity);
  if (!match) {
    return res.status(400).json({
      code: 'INVALID_LEGACY_SOURCE',
      error: 'Invalid legacy CardDAV source identity',
    });
  }

  const [, kind, id] = match;

  if (kind === 'connection') {
    const source = await query<{ id: string; integration_id: string | null }>(
      `SELECT id, integration_id
         FROM source_connections
        WHERE id = $1
          AND user_id = $2
          AND kind = 'carddav'`,
      [id, userId],
    );

    if (!source.rows[0]) {
      return res.status(404).json({
        code: 'SOURCE_NOT_AVAILABLE',
        error: 'Legacy CardDAV source not found',
      });
    }

    // A source with integration_id is a current CardDAV source. Do not let the
    // legacy cleanup path bypass normal source isolation/lifecycle.
    if (source.rows[0].integration_id) {
      return res.status(409).json({
        code: 'CURRENT_SOURCE',
        error: 'This CardDAV source is still connected and must be disconnected normally',
      });
    }

    // Remove only address books owned by this exact legacy source connection.
    // integration_collections is checked too because older projections may
    // predate address_books.source_connection_id.
    await withTransaction(async client => {
      await client.query(
        `DELETE FROM address_books ab
          WHERE ab.user_id = $1
            AND ab.source = 'carddav'
            AND (
              ab.source_connection_id = $2
              OR EXISTS (
                SELECT 1
                  FROM integration_collections ic
                 WHERE ic.user_id = ab.user_id
                   AND ic.kind = 'address_book'
                   AND ic.local_address_book_id = ab.id
                   AND ic.source_connection_id = $2
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM source_connections owner
               WHERE owner.id = ab.source_connection_id
                 AND owner.user_id = ab.user_id
                 AND owner.integration_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1
                FROM integration_collections ic
                JOIN source_connections owner ON owner.id = ic.source_connection_id
                 AND owner.user_id = ic.user_id
               WHERE ic.user_id = ab.user_id
                 AND ic.kind = 'address_book'
                 AND ic.local_address_book_id = ab.id
                 AND owner.integration_id IS NOT NULL
            )`,
        [userId, id],
      );

      // Retained books may still reference this legacy connection with ON DELETE
      // CASCADE. Keep that metadata until those books no longer depend on it.
      await client.query(
        `DELETE FROM source_connections sc
          WHERE sc.id = $1
            AND sc.user_id = $2
            AND sc.kind = 'carddav'
            AND sc.integration_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM address_books ab
               WHERE ab.source_connection_id = sc.id
            )`,
        [id, userId],
      );
    });

    return res.status(204).end();
  }

  // Very old projections can have no source connection at all. In that case
  // the displayed book itself is the only unambiguous local identity.
  const book = await query<{
    id: string;
    source_connection_id: string | null;
    linked: boolean;
  }>(
    `SELECT ab.id,
            ab.source_connection_id,
            EXISTS (
              SELECT 1
                FROM integration_collections ic
               WHERE ic.user_id = ab.user_id
                 AND ic.kind = 'address_book'
                 AND ic.local_address_book_id = ab.id
                 AND (
                   ic.source_connection_id IS NOT NULL
                   OR ic.connection_id IS NOT NULL
                 )
            ) AS linked
       FROM address_books ab
      WHERE ab.id = $1
        AND ab.user_id = $2
        AND ab.source = 'carddav'`,
    [id, userId],
  );

  if (!book.rows[0]) {
    return res.status(404).json({
      code: 'SOURCE_NOT_AVAILABLE',
      error: 'Legacy CardDAV source not found',
    });
  }

  if (book.rows[0].source_connection_id || book.rows[0].linked) {
    return res.status(409).json({
      code: 'CURRENT_SOURCE',
      error: 'This CardDAV book is still attached to a source connection',
    });
  }

  await query(
    `DELETE FROM address_books
      WHERE id = $1
        AND user_id = $2
        AND source = 'carddav'`,
    [id, userId],
  );

  return res.status(204).end();
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
