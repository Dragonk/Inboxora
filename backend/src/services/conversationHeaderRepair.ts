import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { conversationSerializeKey } from './conversationPersistence.js';

// One payload is decoded at a time; unusual larger values are reported, never
// truncated or loaded into a maintenance process on a memory-constrained host.
export const MAX_REPAIR_HEADER_BYTES = 16 * 1024 * 1024;
export const HEADER_REPAIR_SCAN_LIMIT = 250;
export const HEADER_REPAIR_WRITE_LIMIT = 50;
export const HEADER_REPAIR_BATCH_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep the original UUID order. UID/folder may change after a move and cannot
 * represent a previously saved UUID position without skipping pending rows. */
function repairCursor(value: string | null): string | null {
  if (value === null || UUID.test(value)) return value;
  // An earlier, unshipped PR prototype used a UID/folder cursor. Restart that
  // scan safely; already repaired headers do not match and are not counted twice.
  if (value.startsWith('v2:') && value.length <= 4096) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8'));
      if (parsed && typeof parsed === 'object' && 'uid' in parsed && 'folder' in parsed
        && typeof parsed.uid === 'string' && /^-?\d+$/.test(parsed.uid)
        && typeof parsed.folder === 'string') return null;
    } catch { /* malformed cursor must not silently advance repair progress */ }
  }
  throw new Error('Invalid header repair cursor');
}

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

export type HeaderRepairStage = 'scan' | 'inspect_headers' | 'read_payload' | 'write_payload';

export interface HeaderRepairOptions {
  userId: string;
  accountId: string;
  afterId?: string | null;
  limit?: number;
  apply?: boolean;
  onStage?: (stage: HeaderRepairStage) => void;
}

/** Caller owns the transaction and, for writes, the conversation account lock. */
export async function repairConversationHeadersWithClient(client: PoolClient, {
  userId, accountId, afterId = null, limit = 50, apply = false, onStage,
}: HeaderRepairOptions): Promise<HeaderRepairStats> {
  if (!Number.isInteger(limit) || limit < 1 || limit > HEADER_REPAIR_SCAN_LIMIT) throw new Error('Repair limit must be an integer from 1 to 250');
  const cursor = repairCursor(afterId);
  if (!apply) await client.query('SET TRANSACTION READ ONLY');
  // First LIMIT the cheap UUID/index walk. Do not search the entire account's
  // potentially TOASTed headers to find 50 matches (or to prove none remain).
  // Migration 0165 provides the full account/UUID index, including Graph rows.
  onStage?.('scan');
  const page = await client.query<{ id: string }>(`
    SELECT m.id FROM messages m JOIN email_accounts a ON a.id=m.account_id
     WHERE m.account_id=$1 AND a.user_id=$2 ${cursor === null ? '' : 'AND m.id > $4::uuid'}
     ORDER BY m.id LIMIT $3`, cursor === null ? [accountId,userId,limit] : [accountId,userId,limit,cursor]);
  const last = page.rows.at(-1);
  const stats: HeaderRepairStats = {
    scanned: page.rows.length, repairable: 0, repaired: 0, skipped: 0,
    beforeBytes: 0, afterBytes: 0,
    next: page.rows.length === limit && last ? last.id : null,
  };
  if (!last) return stats;
  onStage?.('inspect_headers');
  const candidates = await client.query<{ id: string; bytes: number }>(`
    SELECT id, octet_length(conversation_raw_headers) AS bytes FROM messages
     WHERE account_id=$1 AND id=ANY($2::uuid[])
       AND conversation_raw_headers LIKE '0: %'
     ORDER BY id ${apply ? 'FOR UPDATE' : ''}`, [accountId,page.rows.map(row => row.id)]);
  let lastInspected: string | null = null;
  let payloadsRead = 0;
  let payloadBytes = 0;
  for (const candidate of candidates.rows) {
    // Sparse pages advance by 250 rows, but dense pages retain a 50-payload /
    // 32 MiB work budget. Resume at the last inspected UUID, not the end of a
    // page whose candidates we have not processed. All updates/checkpoint commit
    // together in the caller's transaction.
    if (payloadsRead >= HEADER_REPAIR_WRITE_LIMIT
      || (payloadBytes > 0 && candidate.bytes <= MAX_REPAIR_HEADER_BYTES
        && payloadBytes + candidate.bytes > HEADER_REPAIR_BATCH_BYTES)) {
      stats.next = lastInspected;
      stats.scanned = page.rows.findIndex(row => row.id === lastInspected) + 1;
      break;
    }
    lastInspected = candidate.id;
    if (candidate.bytes > MAX_REPAIR_HEADER_BYTES) { stats.skipped++; continue; }
    onStage?.('read_payload');
    const result = await client.query<{ conversation_raw_headers: string }>(`
      SELECT conversation_raw_headers FROM messages
       WHERE id=$1 AND account_id=$2 AND octet_length(conversation_raw_headers)<=$3`,
    [candidate.id,accountId,MAX_REPAIR_HEADER_BYTES]);
    const current = result.rows[0]?.conversation_raw_headers;
    payloadsRead++;
    payloadBytes += typeof current === 'string' ? Buffer.byteLength(current) : 0;
    const decoded = typeof current === 'string' ? decodeLegacyConversationHeaders(current) : null;
    if (decoded === null) { stats.skipped++; continue; }
    stats.repairable++;
    stats.beforeBytes += Buffer.byteLength(current);
    stats.afterBytes += Buffer.byteLength(decoded);
    if (apply) {
      onStage?.('write_payload');
      const updated = await client.query(`UPDATE messages SET conversation_raw_headers=$1
        WHERE id=$2 AND account_id=$3 AND conversation_raw_headers=$4`, [decoded,candidate.id,accountId,current]);
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
