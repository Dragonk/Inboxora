import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { encrypt, isEncrypted } from './encryption.js';
import { recordDb } from './performanceMetrics.js';
import { toAppError } from '../utils/errors.js';

const { Pool } = pg;

function databasePort(value: string | undefined): number {
  if (typeof value !== 'string') return 5432;
  const port = Number.parseInt(value, 10);
  return port || 5432;
}

export const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: databasePort(process.env.DB_PORT),
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

// pg removes failed idle clients itself, then emits on the pool. Without a
// listener, a database restart throws an uncaught error and kills the API.
pool.on('error', err => {
  console.error('Idle PostgreSQL connection error:', err.message);
});

/**
 * A row from a dynamic SQL query. Columns differ per query and are validated by the
 * SQL string itself, so values stay untyped at this single database boundary; every
 * call site narrows what it reads. Typing this as Record<string, unknown> was measured
 * to cascade into ~220 errors across call sites — a separate, dedicated refactor.
 */
/**
 * A row from a dynamic SQL query.
 *
 * A call site that reads columns declares its own row type through the generic below
 * (`query<AccountRow>(...)`); until then the row stays untyped at this single boundary,
 * which is why the alias itself uses unknown values at this boundary.
 */
export type DbRow = Record<string, unknown>;

/** The slice of a pool/transaction client this codebase uses. */
export interface DbQueryResult<T> {
  rows: T[];
  rowCount?: number;
}

export interface DbClient {
  query<T = DbRow>(text: string, params?: unknown[]): Promise<DbQueryResult<T>>;
}

export async function query<T = DbRow>(text: string, params: unknown[] = []): Promise<DbQueryResult<T>> {
  // Time the query for the performance baseline (behavior-neutral). This is the
  // single top-level DB chokepoint; transaction clients (withTransaction) are not
  // timed here. process.hrtime avoids clock-skew and is ~nanosecond overhead.
  const start = process.hrtime.bigint();
  try {
    const result = await pool.query<T & QueryResultRow>(text, params);
    if (result.rowCount === null) return { rows: result.rows };
    return { rows: result.rows, rowCount: result.rowCount };
  } finally {
    recordDb(Number(process.hrtime.bigint() - start) / 1e6);
  }
}

// Run fn(client) inside a serializable transaction. Commits on success, rolls
// back on throw. The client exposes a .query(text, params) method identical to
// the top-level query() helper.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  { serializable = false, retries = 2, serializeKey = null }: { serializable?: boolean; retries?: number; serializeKey?: string | null } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = await pool.connect();
    let advisoryLocked = false;
    let discardClient = false;
    try {
      // A session advisory lock is acquired BEFORE BEGIN. A transaction that had to wait
      // therefore starts SERIALIZABLE with a fresh snapshot instead of waiting inside an
      // already-open transaction and immediately conflicting with the transaction ahead of it.
      if (serializeKey) {
        await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [serializeKey, serializeKey + ':2']);
        advisoryLocked = true;
      }
      await client.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // P2-02: Don't let a failed ROLLBACK mask the original error.
      try {
        await client.query('ROLLBACK');
      } catch (caught) {
        const rollbackErr = toAppError(caught);
        console.warn('ROLLBACK failed (original error preserved):', rollbackErr.message);
      }
      const txErr = toAppError(err);
      if (serializable && (txErr.code === '40001' || txErr.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      if (advisoryLocked && serializeKey) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS unlocked', [serializeKey, serializeKey + ':2']);
          if (unlocked.rows[0]?.unlocked !== true) discardClient = true;
        } catch (caught) {
          discardClient = true;
          console.warn('Conversation serialization advisory unlock failed:', toAppError(caught).message);
        }
      }
      client.release(discardClient);
    }
  }
  throw new Error('Transaction retry limit exceeded');
}

/**
 * Run `fn` inside a SAVEPOINT, so a statement that fails can be undone **without** aborting the surrounding
 * transaction.
 *
 * PostgreSQL puts a transaction into the aborted state after any SQL error; every later statement then fails
 * with `25P02` until the transaction is rolled back. Code that catches a `23505` and retries an INSERT on the
 * same client inside the same transaction — the "the name is taken, try the next suffix" loops — therefore did
 * not retry at all: the retry failed with `25P02` and the whole operation was lost (DB-01). Rolling back to a
 * savepoint restores the transaction to a usable state, which is what makes such a retry real.
 */
export async function withSavepoint<T>(client: PoolClient, name: string, fn: () => Promise<T>): Promise<T> {
  // Savepoint names are identifiers; the caller's counter keeps them unique within one transaction.
  const savepoint = `sp_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    // Rolling back to the savepoint discards the failed statement but keeps everything before it. A failure of
    // the rollback itself is not swallowed silently: it is reported alongside the original error.
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      console.warn(`ROLLBACK TO SAVEPOINT ${savepoint} failed:`, toAppError(rollbackError).message);
    }
    throw error;
  }
}

// One-time startup migration: encrypt any plaintext credentials still in the DB.
// Safe to run on every startup — already-encrypted values are skipped by isEncrypted().
type EmailCredentialRow = {
  id: string;
  auth_pass: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
};

type OidcProviderCredentialRow = {
  id: string;
  client_secret: string | null;
};

type CalendarImportSourceCredentialRow = {
  id: string;
  url: string | null;
  last_error: string | null;
};

export async function encryptExistingCredentials() {
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('ENCRYPTION_KEY not set — stored credentials are NOT encrypted. Set ENCRYPTION_KEY in .env to enable at-rest encryption.');
    return;
  }

  const result = await pool.query<EmailCredentialRow & QueryResultRow>(`
    SELECT id, auth_pass, oauth_access_token, oauth_refresh_token
    FROM email_accounts
    WHERE (auth_pass IS NOT NULL AND auth_pass NOT LIKE 'enc:v1:%')
       OR (oauth_access_token IS NOT NULL AND oauth_access_token NOT LIKE 'enc:v1:%')
       OR (oauth_refresh_token IS NOT NULL AND oauth_refresh_token NOT LIKE 'enc:v1:%')
  `);

  let count = 0;
  for (const row of result.rows) {
    const updates: Array<{ column: string; value: string }> = [];
    if (row.auth_pass && !isEncrypted(row.auth_pass))
      updates.push({ column: 'auth_pass', value: encrypt(row.auth_pass) });
    if (row.oauth_access_token && !isEncrypted(row.oauth_access_token))
      updates.push({ column: 'oauth_access_token', value: encrypt(row.oauth_access_token) });
    if (row.oauth_refresh_token && !isEncrypted(row.oauth_refresh_token))
      updates.push({ column: 'oauth_refresh_token', value: encrypt(row.oauth_refresh_token) });

    if (updates.length > 0) {
      const sets = updates.map(({ column }, index) => `${column} = $${index + 1}`);
      await pool.query(
        `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${updates.length + 1}`,
        [...updates.map(({ value }) => value), row.id]
      );
      count++;
    }
  }
  if (count > 0) console.log(`Encrypted credentials for ${count} account(s)`);

  // Also encrypt OIDC provider client secrets
  const oidcResult = await pool.query<OidcProviderCredentialRow & QueryResultRow>(`
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

  // Encrypt legacy calendar URLs after migrations have added their fingerprint.
  // The URL predicate makes this race-safe: a concurrent update is never
  // overwritten by a stale plaintext value read above.
  const sourceResult = await pool.query<CalendarImportSourceCredentialRow & QueryResultRow>(`
    SELECT id, url, last_error FROM calendar_import_sources
    WHERE url IS NOT NULL AND url NOT LIKE 'enc:v1:%'
  `);
  let sourceCount = 0;
  for (const row of sourceResult.rows) {
    if (!row.url || isEncrypted(row.url)) continue;
    const encryptedUrl = encrypt(row.url);
    const safeError = typeof row.last_error === 'string'
      ? row.last_error.replaceAll(row.url, '[redacted]')
      : row.last_error;
    const updated = await pool.query(
      `UPDATE calendar_import_sources SET url = $1, last_error = $2, updated_at = NOW()
       WHERE id = $3 AND url = $4 AND url_fingerprint IS NOT NULL`,
      [encryptedUrl, safeError, row.id, row.url],
    );
    if (updated.rowCount) sourceCount++;
  }
  if (sourceCount > 0) console.log(`Encrypted URLs for ${sourceCount} calendar source(s)`);
}
