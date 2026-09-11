import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireDeviceAuth } from '../middleware/deviceAuth.js';
import {
  listPushDevices,
  pruneStalePushDevices,
  registerPushDevice,
  removeAllPushDevices,
  removePushDevice,
} from '../services/pushDevices.js';
import { transportStatus } from '../services/pushTransports.js';
import { pushConfigured } from '../services/pushNotifications.js';
import { query } from '../services/db.js';
import { validateHost } from '../services/hostValidation.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function allowPrivatePushEndpoints() {
  return process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true';
}

// ── Authenticated device management (/api/push/devices) ──────────────────────

router.get('/devices', requireAuth, async (req, res) => {
  const devices = await listPushDevices(req.session.userId);
  res.json({
    devices: devices.map((device) => ({
      id: device.id,
      deviceId: device.device_id,
      platform: device.platform,
      transport: device.transport,
      appVersion: device.app_version,
      createdAt: device.created_at,
      updatedAt: device.updated_at,
      lastSeen: device.last_seen,
      disabled: !!device.disabled_at,
    })),
  });
});

// Register (or refresh) this install's native push endpoint. Requires a logged-in
// session: a caller can only ever register for themselves — the user id comes
// from the session, never from the body (no cross-user token registration).
router.post('/devices', requireAuth, async (req, res) => {
  try {
    const input = req.body || {};

    // SSRF guard at registration time as well as at send time: a logged-in user
    // must not be able to store an internal callback URL and have the server POST
    // new-mail events to it. Self-hosted LAN distributors can opt in explicitly.
    if (String(input.transport || '').toLowerCase() === 'unifiedpush') {
      let endpointUrl;
      try { endpointUrl = new URL(String(input.endpoint || '')); } catch {
        return res.status(400).json({ error: 'UnifiedPush endpoint must be a valid URL' });
      }
      if (endpointUrl.protocol !== 'https:') {
        return res.status(400).json({ error: 'UnifiedPush endpoint must use HTTPS' });
      }
      const hostErr = await validateHost(endpointUrl.hostname, { allowPrivate: allowPrivatePushEndpoints() });
      if (hostErr) return res.status(400).json({ error: 'UnifiedPush endpoint host is not allowed' });
    }

    const { device, deviceToken } = await registerPushDevice(req.session.userId, input);
    // Opportunistic, bounded cleanup so expired registrations cannot accumulate.
    pruneStalePushDevices().catch(() => {});
    res.status(201).json({
      device: {
        id: device.id,
        deviceId: device.device_id,
        platform: device.platform,
        transport: device.transport,
        appVersion: device.app_version,
        createdAt: device.created_at,
        updatedAt: device.updated_at,
        lastSeen: device.last_seen,
      },
      // Returned exactly once. The app stores it in its encrypted native store.
      deviceToken,
    });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Logout / "forget this device" from a trustworthy session.
router.delete('/devices', requireAuth, async (req, res) => {
  const removed = await removeAllPushDevices(req.session.userId);
  res.json({ ok: true, removed });
});

// Unregister by the app-generated device id. Scoped to the session's user, so a
// device id belonging to another account returns 404 rather than deleting it.
router.delete('/devices/:deviceId', requireAuth, async (req, res) => {
  const device = await removePushDevice(req.session.userId, req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Push device not found' });
  res.json({ ok: true, device: { id: device.id, deviceId: device.device_id } });
});

// What the settings screen renders: which transports this server can use and
// whether the browser leg is configured. Never exposes endpoints or tokens.
router.get('/status', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE disabled_at IS NULL)::int AS active
       FROM push_devices WHERE user_id = $1`,
    [req.session.userId],
  );
  res.json({
    webPushConfigured: pushConfigured,
    nativeTransports: transportStatus(),
    devices: result.rows[0] || { total: 0, active: 0 },
  });
});

// ── Native background API (/api/push/native/*) — device-token auth ───────────
//
// The external push provider only ever carries { type, eventId }. The app wakes
// on that, then fetches the actual notification data straight from its own
// Inboxora server over this mount. Nothing else is reachable with a device token.

function unreadTotalSql() {
  return `SELECT COUNT(*)::int AS total FROM messages m
          JOIN email_accounts a ON a.id = m.account_id
          WHERE a.user_id = $1 AND a.enabled = true AND m.folder = 'INBOX'
            AND m.is_read = false AND m.is_deleted = false`;
}

function messageSummary(row) {
  return {
    messageId: row.id,
    accountId: row.account_id,
    folder: row.folder,
    title: row.from_name || row.from_email || 'New mail',
    body: row.subject || '(no subject)',
  };
}

// Fetch the notification details for one specific event id (the message UUID
// carried opaquely through the provider). Ownership is enforced in SQL, so a
// leaked event id from another account cannot be read.
router.get('/native/messages/:id', requireDeviceAuth, async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.account_id, m.folder
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false`,
    [id, req.pushDevice.userId],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });

  const counts = await query(unreadTotalSql(), [req.pushDevice.userId]);
  res.json({
    eventId: id,
    message: messageSummary(result.rows[0]),
    unreadCount: counts.rows[0]?.total ?? 0,
  });
});

// Reconciliation endpoint for the WorkManager fallback: latest unread INBOX
// message (if any) plus the authoritative unread total. Returns the same
// message id the push event would carry so the client can dedup either path.
router.get('/native/inbox', requireDeviceAuth, async (req, res) => {
  const latest = await query(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.account_id, m.folder
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND a.enabled = true AND m.folder = 'INBOX'
        AND m.is_read = false AND m.is_deleted = false
      ORDER BY m.date DESC NULLS LAST, m.id DESC
      LIMIT 1`,
    [req.pushDevice.userId],
  );
  const counts = await query(unreadTotalSql(), [req.pushDevice.userId]);
  res.json({
    message: latest.rows[0] ? messageSummary(latest.rows[0]) : null,
    eventId: latest.rows[0]?.id ?? null,
    unreadCount: counts.rows[0]?.total ?? 0,
  });
});

export default router;
