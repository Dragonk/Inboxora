import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from './db.js';

const PREFIX_RE = /^(mf_dav_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{16,})$/;
const BCRYPT_ROUNDS = 12;

export function parseDavAppPassword(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(PREFIX_RE);
  return match ? { prefix: match[1], secret: match[2] } : null;
}

function normalizedLabel(label) {
  const value = typeof label === 'string' ? label.trim() : '';
  if (!value || value.length > 120) throw new Error('A device label between 1 and 120 characters is required');
  return value;
}

export async function createDavAppPassword(userId, label) {
  if (!userId) throw new Error('User id is required');
  const prefix = `mf_dav_${crypto.randomUUID()}`;
  const secretPart = crypto.randomBytes(32).toString('base64url');
  const secret = `${prefix}.${secretPart}`;
  const secretHash = await bcrypt.hash(secretPart, BCRYPT_ROUNDS);
  const result = await query(
    `INSERT INTO dav_app_passwords (user_id, label, token_prefix, secret_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, created_at`,
    [userId, normalizedLabel(label), prefix, secretHash],
  );
  return { ...result.rows[0], secret };
}

export async function listDavAppPasswords(userId) {
  if (!userId) throw new Error('User id is required');
  const result = await query(
    `SELECT id, label, created_at, last_used_at
     FROM dav_app_passwords
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function revokeDavAppPassword(userId, passwordId) {
  if (!userId || !passwordId) return null;
  const result = await query(
    `UPDATE dav_app_passwords
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id, revoked_at`,
    [passwordId, userId],
  );
  return result.rows[0] || null;
}

export async function findActiveDavAppPassword(userId, value) {
  const parsed = parseDavAppPassword(value);
  if (!userId || !parsed) return null;
  const result = await query(
    `SELECT id, secret_hash FROM dav_app_passwords
     WHERE user_id = $1 AND token_prefix = $2 AND revoked_at IS NULL`,
    [userId, parsed.prefix],
  );
  const password = result.rows[0];
  if (!password || !(await bcrypt.compare(parsed.secret, password.secret_hash))) return null;
  await query('UPDATE dav_app_passwords SET last_used_at = NOW() WHERE id = $1', [password.id]);
  return { id: password.id };
}

export async function verifyDavAppPassword(userId, value) {
  return Boolean(await findActiveDavAppPassword(userId, value));
}
