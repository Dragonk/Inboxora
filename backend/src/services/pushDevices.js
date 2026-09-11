import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from './db.js';
import { encrypt, decrypt } from './encryption.js';

// A native push device is stored in push_devices. The row carries two secrets:
//   1. the provider endpoint/token (FCM registration token or a UnifiedPush
//      distributor URL) — encrypted at rest, used only by the dispatcher;
//   2. the Inboxora device token (mf_push_<uuid>.<secret>) — returned once at
//      registration and stored only as a bcrypt hash. It authenticates the
//      app's background requests (fetching notification details, delete/star)
//      even after the WebView session cookie has expired, without ever copying
//      the user's password into native storage.
//
// The endpoint is NEVER logged: dispatcher failures redact it.
const TOKEN_RE = /^(mf_push_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{16,})$/;
const BCRYPT_ROUNDS = 12;

export const DEVICE_PLATFORMS = new Set(['android', 'ios', 'web', 'desktop']);
// Native transports only. Browser Web Push keeps using push_subscriptions.
export const NATIVE_TRANSPORTS = new Set(['unifiedpush', 'fcm']);

const MAX_DEVICE_ID = 128;
const MAX_ENDPOINT = 4096;
const MAX_APP_VERSION = 64;

export function parseDeviceToken(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(TOKEN_RE);
  return match ? { prefix: match[1], secret: match[2] } : null;
}

export function bearerTokenFromHeader(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function generateDeviceToken() {
  const prefix = `mf_push_${crypto.randomUUID()}`;
  const secret = crypto.randomBytes(32).toString('base64url');
  return { prefix, secret, token: `${prefix}.${secret}` };
}

function trimmed(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export function validateDeviceRegistration(input) {
  const deviceId = trimmed(input?.deviceId, MAX_DEVICE_ID);
  if (!deviceId) throw Object.assign(new Error('deviceId is required'), { statusCode: 400 });

  const platform = trimmed(input?.platform, 16).toLowerCase();
  if (!DEVICE_PLATFORMS.has(platform)) throw Object.assign(new Error('Unsupported platform'), { statusCode: 400 });

  const transport = trimmed(input?.transport, 32).toLowerCase();
  if (!NATIVE_TRANSPORTS.has(transport)) throw Object.assign(new Error('Unsupported push transport'), { statusCode: 400 });

  const endpoint = trimmed(input?.endpoint, MAX_ENDPOINT);
  if (!endpoint) throw Object.assign(new Error('endpoint is required'), { statusCode: 400 });

  if (transport === 'unifiedpush') {
    let url;
    try { url = new URL(endpoint); } catch { throw Object.assign(new Error('UnifiedPush endpoint must be a valid URL'), { statusCode: 400 }); }
    if (url.protocol !== 'https:') throw Object.assign(new Error('UnifiedPush endpoint must use HTTPS'), { statusCode: 400 });
  }

  const appVersion = trimmed(input?.appVersion, MAX_APP_VERSION) || null;
  return { deviceId, platform, transport, endpoint, appVersion };
}

// Register or refresh a device. Returns the plaintext device token exactly once;
// it is never retrievable afterwards. Registering an existing (user_id, device_id)
// rotates the token so a fresh install or a lost token can recover.
export async function registerPushDevice(userId, input) {
  if (!userId) throw Object.assign(new Error('user id is required'), { statusCode: 400 });
  const device = validateDeviceRegistration(input);
  const { prefix, secret, token } = generateDeviceToken();
  const secretHash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
  const encryptedEndpoint = encrypt(device.endpoint);

  const result = await query(
    `INSERT INTO push_devices
       (user_id, device_id, platform, transport, endpoint, token_prefix, token_hash, app_version, updated_at, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     ON CONFLICT (user_id, device_id) DO UPDATE SET
       platform = EXCLUDED.platform,
       transport = EXCLUDED.transport,
       endpoint = EXCLUDED.endpoint,
       token_prefix = EXCLUDED.token_prefix,
       token_hash = EXCLUDED.token_hash,
       app_version = EXCLUDED.app_version,
       failure_count = 0,
       disabled_at = NULL,
       updated_at = NOW(),
       last_seen = NOW()
     RETURNING id, device_id, platform, transport, app_version, created_at, updated_at, last_seen`,
    [userId, device.deviceId, device.platform, device.transport, encryptedEndpoint, prefix, secretHash, device.appVersion],
  );

  return { device: result.rows[0], deviceToken: token };
}

export async function listPushDevices(userId) {
  const result = await query(
    `SELECT id, device_id, platform, transport, app_version, created_at, updated_at, last_seen, disabled_at
     FROM push_devices
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

// Remove one device, scoped to its owner so a device id from another account
// can never be used to unregister someone else's endpoint (IDOR).
export async function removePushDevice(userId, deviceId) {
  if (!userId || !deviceId) return null;
  const result = await query(
    'DELETE FROM push_devices WHERE user_id = $1 AND device_id = $2 RETURNING id, device_id, transport',
    [userId, String(deviceId).slice(0, MAX_DEVICE_ID)],
  );
  return result.rows[0] || null;
}

// Used on logout / host change when the app cannot know the server-side row id.
export async function removeAllPushDevices(userId) {
  if (!userId) return 0;
  const result = await query('DELETE FROM push_devices WHERE user_id = $1 RETURNING id', [userId]);
  return result.rowCount || 0;
}

// Authenticate a background request by its device token. Returns the owning
// user id, or null. Prefix lookup keeps it one indexed query + one bcrypt check.
export async function authenticatePushDevice(tokenValue) {
  const parsed = parseDeviceToken(tokenValue);
  if (!parsed) return null;
  const result = await query(
    `SELECT id, user_id, device_id, transport, token_hash
     FROM push_devices
     WHERE token_prefix = $1 AND disabled_at IS NULL`,
    [parsed.prefix],
  );
  const device = result.rows[0];
  if (!device || !(await bcrypt.compare(parsed.secret, device.token_hash))) return null;
  await query('UPDATE push_devices SET last_seen = NOW() WHERE id = $1', [device.id]).catch(() => {});
  return { id: device.id, userId: device.user_id, deviceId: device.device_id, transport: device.transport };
}

// Dispatch read: active devices for one user with decrypted endpoints. Rows whose
// endpoint can no longer be decrypted (rotated ENCRYPTION_KEY) are skipped.
export async function listActivePushDevices(userId) {
  const result = await query(
    `SELECT id, device_id, platform, transport, endpoint, failure_count
     FROM push_devices
     WHERE user_id = $1 AND disabled_at IS NULL`,
    [userId],
  );
  return result.rows.map((row) => ({ ...row, endpoint: decrypt(row.endpoint) })).filter((row) => !!row.endpoint);
}

export async function markPushDeviceFailure(id) {
  if (!id) return;
  await query(
    'UPDATE push_devices SET failure_count = failure_count + 1, updated_at = NOW() WHERE id = $1',
    [id],
  ).catch(() => {});
}

// Permanent provider rejection (410/404, FCM UNREGISTERED): stop dispatching.
export async function disablePushDevice(id) {
  if (!id) return;
  await query(
    `UPDATE push_devices SET disabled_at = NOW(), endpoint = '', token_hash = NULL, token_prefix = NULL, updated_at = NOW() WHERE id = $1`,
    [id],
  ).catch(() => {});
}

// Bounded cleanup for expired registrations. Called opportunistically by the
// registration route; safe to run repeatedly.
export async function pruneStalePushDevices() {
  const result = await query(
    `DELETE FROM push_devices
     WHERE (disabled_at IS NOT NULL AND disabled_at < NOW() - INTERVAL '30 days')
        OR (last_seen < NOW() - INTERVAL '180 days')`,
  );
  return result.rowCount || 0;
}
