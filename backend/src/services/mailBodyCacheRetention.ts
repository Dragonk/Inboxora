import type { PoolClient } from 'pg';
import { readStorageRetentionPolicy } from './storageRetentionSettings.js';

export const BODY_CACHE_RETENTION_BATCH = 100;

/** Only provider-backed caches, never canonical local data. No network request
 * or provider DELETE is issued. Protect drafts, disconnected/ambiguous sources,
 * pending body-dependent work and unresolved outgoing delivery state. */
export async function expireMailBodyCache(client: PoolClient): Promise<{evicted: number; logicalBytes: number}> {
  const { mail_body_cache_days: days } = await readStorageRetentionPolicy(client);
  if (days === 0) return { evicted: 0, logicalBytes: 0 };
  const result = await client.query<{evicted: number; logical_bytes: string}>(`
    WITH candidates AS MATERIALIZED (
      SELECT m.id, COALESCE(octet_length(m.body_text),0)::bigint + COALESCE(octet_length(m.body_html),0)::bigint AS logical_bytes
        FROM messages m JOIN email_accounts a ON a.id=m.account_id
       WHERE (m.body_text IS NOT NULL OR m.body_html IS NOT NULL)
         AND GREATEST(m.body_cache_refreshed_at,m.body_last_opened_at) < NOW() - $1 * INTERVAL '1 day'
         AND a.enabled = true AND m.is_deleted = false
         AND m.draft_composition IS NULL AND m.draft_uid_validity IS NULL
         AND NOT COALESCE(m.flags,'[]'::jsonb) ? (chr(92)||'Draft')
         AND NOT 'DRAFT' = ANY(COALESCE(m.provider_labels,ARRAY[]::text[]))
         AND lower(m.folder) NOT LIKE '%draft%'
         AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.account_id=a.id AND f.path=m.folder AND f.special_use=chr(92)||'Drafts')
         AND (
           (COALESCE(a.mail_transport,'imap_smtp')='imap_smtp' AND a.protocol='imap' AND m.uid>0
             AND EXISTS (SELECT 1 FROM folders f WHERE f.account_id=a.id AND f.path=m.folder AND f.uid_validity>0))
           OR (a.mail_transport IN ('gmail_api','microsoft_graph') AND NULLIF(btrim(m.provider_message_id),'') IS NOT NULL
             AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.id=a.provider_connection_id AND pc.user_id=a.user_id AND pc.status='active'))
         )
         AND NOT EXISTS (SELECT 1 FROM provider_rule_deferred_messages p WHERE p.message_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM inbox_rule_forwards f WHERE f.message_id=m.id AND f.status='pending')
         AND NOT EXISTS (SELECT 1 FROM graph_pending_message_removals g WHERE g.message_row_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM provider_operations p WHERE p.resource_id=m.id AND p.status NOT IN ('committed','failed','cancelled'))
         AND NOT EXISTS (SELECT 1 FROM send_idempotency s WHERE s.user_id=a.user_id AND s.status<>'completed')
       ORDER BY GREATEST(m.body_cache_refreshed_at,m.body_last_opened_at),m.id
       LIMIT $2 FOR UPDATE OF m SKIP LOCKED
    ), cleared AS (
      UPDATE messages m SET body_text=NULL, body_html=NULL,
        gmail_reader_body_complete=false, gmail_rule_body_complete=false,
        graph_reader_body_complete=false, body_cache_evicted_at=clock_timestamp()
      FROM candidates c WHERE m.id=c.id
      RETURNING c.logical_bytes
    ) SELECT COUNT(*)::int AS evicted,COALESCE(SUM(logical_bytes),0)::text AS logical_bytes FROM cleared`, [days, BODY_CACHE_RETENTION_BATCH]);
  return { evicted: result.rows[0].evicted, logicalBytes: Number(result.rows[0].logical_bytes) };
}
