import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { findActiveDavAppPassword } from './davAppPasswords.js';
import type { DavMaxMode } from './davAppPasswords.js';

const DUMMY_DAV_SECRET_HASH = bcrypt.hashSync('mailflow-dav-timing-equalizer', 12);

export interface DavCredential {
  userId: string;
  credentialId: string;
  /** The ceiling this device password imposes on every collection it reaches. */
  maxDavMode: DavMaxMode;
}

function hasNonEmptyStringId(value: unknown): value is { id: string } {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.length > 0;
}

/**
 * Authenticates a DAV Basic Auth credential. Primary account passwords are
 * intentionally never accepted here: clients must use a dedicated, revocable
 * DAV application password so TOTP and OIDC-only accounts work consistently.
 */
export async function authenticateDavCredential(
  username: unknown,
  password: unknown,
): Promise<DavCredential | null> {
  if (typeof username !== 'string' || !username || typeof password !== 'string') return null;

  const result = await query('SELECT id FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!hasNonEmptyStringId(user)) {
    await bcrypt.compare(password, DUMMY_DAV_SECRET_HASH);
    return null;
  }

  const credential = await findActiveDavAppPassword(user.id, password);
  if (!hasNonEmptyStringId(credential)) return null;

  return { userId: user.id, credentialId: credential.id, maxDavMode: credential.maxDavMode };
}
