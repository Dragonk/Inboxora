import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { conversationSerializeKey } from './conversationPersistence.js';

// One payload is decoded at a time; unusual larger values are reported, never
// truncated or loaded into a maintenance process on a memory-constrained host.
export const MAX_REPAIR_HEADER_BYTES = 16 * 1024 * 1024;

/** Recover only the exact old Buffer.entries() encoding; leave anything ambiguous intact. */
export function decodeLegacyConversationHeaders(value: string): string | null {
  if (!value.startsWith('0: ') || value.length > MAX_REPAIR_HEADER_BYTES) return null;
  const bytes = Buffer.alloc(Math.ceil(value.length / 6));
  let position = 0;
  let count = 0;
  while (position < value.length) {
    const prefix = `${count}: `;
    if (!value.startsWith(prefix, position)) return null;
    const separator = value.indexOf('\r\n', position);
    const end = separator < 0 ? value.length : separator;
    const decimal = value.slice(position + prefix.length, end);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(decimal)) return null;
    const byte = Number(decimal);
    if (byte > 255 || count >= bytes.length) return null;
    bytes[count++] = byte;
    if (separator < 0) break;
    position = separator + 2;
    if (position === value.length) return null; // old join() never added a trailing CRLF
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } catch {
    return null; // do not replace invalid bytes with U+FFFD during a data repair
  }
  // A byte list that isn't actually a header block is not ours to rewrite.
  // PostgreSQL text cannot contain NUL; do not silently discard it either.
  if (decoded.includes('\0') || !/^(?:\uFEFF)?[!-9;-~]+:/.test(decoded)) return null;
  return decoded;
}

export interface HeaderRepairStats {
  scanned: number;
  repairable: number;
  repaired: number;
  skipped: number;
  beforeBytes: number;
  afterBytes: number;
  next: string | null;
}

export interface HeaderRepairOptions {
  userId: string;
  accountId: string;
  afterId?: string | null;
  limit?: number;
  apply?: boolean;
}

/** Caller owns the transaction and, for writes, the conversation account lock. */
export async function repairConversationHeadersWithClient(client: PoolClient, {
  userId, accountId, afterId = null, limit = 50, apply = false,
}: HeaderRepairOptions): Promise<HeaderRepairStats> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('Repair limit must be an integer from 1 to 250');
    if (!apply) await client.query('SET TRANSACTION READ ONLY');
    const candidates = await client.query<{ id: string; bytes: number }>(`
      SELECT m.id, octet_length(m.conversation_raw_headers) AS bytes
        FROM messages m JOIN email_accounts a ON a.id = m.account_id
       WHERE m.account_id = $1 AND a.user_id = $2
         AND ($3::uuid IS NULL OR m.id > $3::uuid)
         AND m.conversation_raw_headers LIKE '0: %'
       ORDER BY m.id LIMIT $4
       ${apply ? 'FOR UPDATE OF m' : ''}`, [accountId, userId, afterId, limit]);
    const stats: HeaderRepairStats = {
      scanned: candidates.rows.length, repairable: 0, repaired: 0, skipped: 0,
      beforeBytes: 0, afterBytes: 0,
      next: candidates.rows.length === limit ? candidates.rows.at(-1)!.id : null,
    };
    for (const candidate of candidates.rows) {
      if (candidate.bytes > MAX_REPAIR_HEADER_BYTES) { stats.skipped++; continue; }
      // Select payloads one at a time, not one multi-GB result. Recheck the size
      // for a dry run where another client could have changed a row meanwhile.
      const result = await client.query<{ conversation_raw_headers: string }>(`
        SELECT conversation_raw_headers FROM messages
         WHERE id = $1 AND account_id = $2
           AND octet_length(conversation_raw_headers) <= $3`,
      [candidate.id, accountId, MAX_REPAIR_HEADER_BYTES]);
      const current = result.rows[0]?.conversation_raw_headers;
      const decoded = typeof current === 'string' ? decodeLegacyConversationHeaders(current) : null;
      if (decoded === null) { stats.skipped++; continue; }
      stats.repairable++;
      stats.beforeBytes += Buffer.byteLength(current);
      stats.afterBytes += Buffer.byteLength(decoded);
      if (apply) {
        const updated = await client.query(`UPDATE messages SET conversation_raw_headers = $1
          WHERE id = $2 AND account_id = $3 AND conversation_raw_headers = $4`,
        [decoded, candidate.id, accountId, current]);
        if (updated.rowCount !== 1) throw new Error('Header repair lost its locked message row');
        stats.repaired++;
      }
    }
    return stats;
}

/** Explicit CLI wrapper; the background worker commits its checkpoint in the same transaction. */
export async function repairConversationHeadersBatch(options: HeaderRepairOptions): Promise<HeaderRepairStats> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('Repair limit must be an integer from 1 to 250');
  return withTransaction(client => repairConversationHeadersWithClient(client, options), {
    serializeKey: options.apply ? conversationSerializeKey(options.userId, options.accountId) : null,
  });
}

/** Account identifiers only: never print addresses, subjects, headers or credentials. */
export async function conversationHeaderRepairAccounts() {
  return (await query<{ id: string; user_id: string }>('SELECT id, user_id FROM email_accounts ORDER BY id')).rows;
}
