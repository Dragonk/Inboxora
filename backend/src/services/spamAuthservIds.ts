// Setup helper for the trusted-authserv-id field: the Authentication-Results
// authserv-ids actually observed on an account's recently classified mail,
// most frequent first. Nothing is trusted automatically.

import { query } from './db.js';

export interface AuthservIdObservation {
  authservId: string;
  count: number;
}

export async function detectAuthservIds(accountId: string, limit = 200): Promise<{ analyzed: number; detected: AuthservIdObservation[] }> {
  const result = await query<{ authservIds: unknown }>(
    `SELECT m.spam_details
     FROM messages m
     WHERE m.account_id = $1 AND m.spam_details IS NOT NULL
     ORDER BY m.spam_analyzed_at DESC NULLS LAST
     LIMIT $2`,
    [accountId, limit],
  );
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const details = typeof row.authservIds === 'string' ? null : (row as { spam_details?: unknown }).spam_details;
    const parsed = typeof details === 'string' ? safeParse(details) : details;
    if (parsed === null || typeof parsed !== 'object') continue;
    const ids = (parsed as { authservIds?: unknown }).authservIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const detected = [...counts.entries()]
    .map(([authservId, count]) => ({ authservId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  return { analyzed: result.rows.length, detected };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
