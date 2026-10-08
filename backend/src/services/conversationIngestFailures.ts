import { withTransaction } from './db.js';
import { toAppError } from '../utils/errors.js';

export async function recordConversationIngestFailure({ userId, accountId = null, messageRowId = null, operation, error, diagnostics = {} }: {
  userId: string;
  accountId?: string | null;
  messageRowId?: string | null;
  operation: string;
  error: unknown;
  diagnostics?: Record<string, unknown>;
}) {
  if (!userId || !operation || !error) return;
  const appError = toAppError(error);
  await withTransaction(async client => {
    let targetAccountId = accountId;
    if (messageRowId && !targetAccountId) {
      const lookup = await client.query<{ account_id: string }>(
        'SELECT account_id FROM messages WHERE id = $1',
        [messageRowId],
      );
      targetAccountId = lookup.rows[0]?.account_id ?? null;
    }

    if (messageRowId && targetAccountId) {
      await client.query(`
        INSERT INTO conversation_ingest_failures (
          user_id, account_id, message_row_id, operation, error_code, error_message, diagnostics, attempts, next_attempt_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, 1, NOW() + INTERVAL '5 minutes'
        )
        ON CONFLICT (user_id, account_id, message_row_id, operation) WHERE resolved_at IS NULL AND message_row_id IS NOT NULL
        DO UPDATE SET
          attempts = conversation_ingest_failures.attempts + 1,
          error_code = EXCLUDED.error_code,
          error_message = EXCLUDED.error_message,
          diagnostics = EXCLUDED.diagnostics,
          next_attempt_at = NOW() + (LEAST(5 * POWER(2, LEAST(conversation_ingest_failures.attempts, 8)), 1440) || ' minutes')::interval,
          updated_at = NOW()`,
        [userId, targetAccountId, messageRowId, operation, appError.code || null, appError.message, JSON.stringify(diagnostics)],
      );
      return;
    }

    await client.query(`
      INSERT INTO conversation_ingest_failures (user_id, account_id, message_row_id, operation, error_code, error_message, diagnostics)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [userId, targetAccountId, messageRowId, operation, appError.code || null, appError.message, JSON.stringify(diagnostics)],
    );
  });
}

export async function claimConversationIngestFailures({ userId = null, limit = 50 }: { userId?: string | null; limit?: number } = {}) {
  const values: Array<string | number> = [];
  const where = ['resolved_at IS NULL', 'next_attempt_at <= NOW()'];
  if (userId) { values.push(userId); where.push(`user_id = $${values.length}`); }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
  return withTransaction(async client => {
    const result = await client.query(`
      SELECT * FROM conversation_ingest_failures
       WHERE ${where.join(' AND ')}
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $${values.length}
       FOR UPDATE SKIP LOCKED`, values);
    for (const row of result.rows) {
      const nextAttempts = Number(row.attempts ?? 1) + 1;
      const backoffMinutes = Math.min(5 * Math.pow(2, Math.min(nextAttempts - 1, 8)), 1440);
      await client.query(`UPDATE conversation_ingest_failures SET attempts = attempts + 1, next_attempt_at = NOW() + ($1 || ' minutes')::interval, updated_at = NOW() WHERE id = $2`, [backoffMinutes, row.id]);
    }
    return result.rows;
  });
}

export async function resolveConversationIngestFailure(id: string) {
  return withTransaction(async client => client.query('UPDATE conversation_ingest_failures SET resolved_at = NOW(), updated_at = NOW() WHERE id = $1', [id]));
}

export async function resolveConversationIngestFailuresForMessage(
  clientOrPool: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  { userId = null, messageRowId }: { userId?: string | null; messageRowId: string },
) {
  if (!messageRowId) return;
  if (userId) {
    await clientOrPool.query(
      'UPDATE conversation_ingest_failures SET resolved_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND message_row_id = $2 AND resolved_at IS NULL',
      [userId, messageRowId],
    );
  } else {
    await clientOrPool.query(
      'UPDATE conversation_ingest_failures SET resolved_at = NOW(), updated_at = NOW() WHERE message_row_id = $1 AND resolved_at IS NULL',
      [messageRowId],
    );
  }
}
