import pg from 'pg';
import { encrypt, isEncrypted } from './encryption.js';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'mailflow',
  user: process.env.DB_USER || 'mailflow',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Apply statement_timeout via PostgreSQL startup options so it is set during
  // the connection handshake, before any queries can run. The alternative —
  // pool.on('connect') + client.query('SET ...') — is racy: pg does not await
  // the async handler before dispatching the client, so the SET command and the
  // first application query can land on the same client concurrently.
  options: '-c statement_timeout=30000',
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Run fn(client) inside a serializable transaction. Commits on success, rolls
// back on throw. The client exposes a .query(text, params) method identical to
// the top-level query() helper.
export async function withTransaction(fn, { serializable = false, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // P2-02: Don't let a failed ROLLBACK mask the original error.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // ROLLBACK failed — the client is in an indeterminate state.
        // Log the rollback error but throw the original error so the caller
        // sees what actually went wrong, not the secondary ROLLBACK failure.
        console.warn('ROLLBACK failed (original error preserved):', rollbackErr.message);
      }
      if (serializable && (err.code === '40001' || err.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('Transaction retry limit exceeded');
}

// One-time startup migration: encrypt any plaintext credentials still in the DB.
// Safe to run on every startup — already-encrypted values are skipped by isEncrypted().
export async function encryptExistingCredentials() {
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('ENCRYPTION_KEY not set — stored credentials are NOT encrypted. Set ENCRYPTION_KEY in .env to enable at-rest encryption.');
    return;
  }

  const result = await pool.query(`
    SELECT id, auth_pass, oauth_access_token, oauth_refresh_token
    FROM email_accounts
    WHERE (auth_pass IS NOT NULL AND auth_pass NOT LIKE 'enc:v1:%')
       OR (oauth_access_token IS NOT NULL AND oauth_access_token NOT LIKE 'enc:v1:%')
       OR (oauth_refresh_token IS NOT NULL AND oauth_refresh_token NOT LIKE 'enc:v1:%')
  `);

  let count = 0;
  for (const row of result.rows) {
    const updates = {};
    if (row.auth_pass && !isEncrypted(row.auth_pass))
      updates.auth_pass = encrypt(row.auth_pass);
    if (row.oauth_access_token && !isEncrypted(row.oauth_access_token))
      updates.oauth_access_token = encrypt(row.oauth_access_token);
    if (row.oauth_refresh_token && !isEncrypted(row.oauth_refresh_token))
      updates.oauth_refresh_token = encrypt(row.oauth_refresh_token);

    if (Object.keys(updates).length) {
      const keys = Object.keys(updates);
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      await pool.query(
        `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`,
        [...Object.values(updates), row.id]
      );
      count++;
    }
  }
  if (count > 0) console.log(`Encrypted credentials for ${count} account(s)`);

  // Also encrypt OIDC provider client secrets
  const oidcResult = await pool.query(`
    SELECT id, client_secret FROM oidc_providers
    WHERE client_secret IS NOT NULL AND client_secret NOT LIKE 'enc:v1:%'
  `);

  let oidcCount = 0;
  for (const row of oidcResult.rows) {
    if (row.client_secret && !isEncrypted(row.client_secret)) {
      await pool.query(
        'UPDATE oidc_providers SET client_secret = $1 WHERE id = $2',
        [encrypt(row.client_secret), row.id]
      );
      oidcCount++;
    }
  }
  if (oidcCount > 0) console.log(`Encrypted client secrets for ${oidcCount} OIDC provider(s)`);
}
