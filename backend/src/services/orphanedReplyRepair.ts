import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { _upsertConversationCopyWithClient } from './conversationPersistence.js';
import type { ConversationCopyInput } from './conversationPersistence.js';
import { resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';

export interface OrphanedReplyRepairCounters {
  scanned: number;
  repaired: number;
  ambiguous: number;
  missing_parent: number;
  protected_by_manual_override: number;
}

export interface OrphanedReplyRepairOptions {
  userId: string;
  accountId?: string | null;
  limit?: number;
  dryRun?: boolean;
}

type RepairRow = ConversationCopyInput & {
  id: string;
  account_id: string;
  in_reply_to?: string | null;
  thread_references?: string | null;
  manual_protected?: boolean;
  conversation_id?: string | null;
  logical_message_id?: string | null;
};

type RepairClient = Pick<PoolClient, 'query'>;
type ApplyRepair = (client: RepairClient, row: RepairRow, userId: string) => Promise<void>;

const EMPTY_COUNTERS = (): OrphanedReplyRepairCounters => ({
  scanned: 0, repaired: 0, ambiguous: 0, missing_parent: 0, protected_by_manual_override: 0,
});

/** RFC Message-IDs only; subject/address/time never enter the repair decision. */
export function replyParentHeaders(row: Pick<RepairRow, 'in_reply_to' | 'thread_references'>): string[] {
  const inReplyTo = String(row.in_reply_to || '').match(/<[^<>\r\n]+>/g) || [];
  if (inReplyTo.length === 1) return inReplyTo;
  const references = String(row.thread_references || '').match(/<[^<>\r\n]+>/g) || [];
  // RFC References is ordered oldest -> newest. The newest element is the only
  // possible direct parent when In-Reply-To was not retained by a legacy client.
  return references.length ? [references.at(-1)!] : [];
}

function conversationSnapshot(row: RepairRow | undefined) {
  if (!row) return null;
  return JSON.stringify({
    conversation_id: row.conversation_id ?? null,
    logical_message_id: row.logical_message_id ?? null,
  });
}

const defaultApply: ApplyRepair = async (client, row, userId) => {
  await _upsertConversationCopyWithClient(client as PoolClient, row, {
    identities: await resolveOwnIdentityAddresses(client as PoolClient, row.account_id, row),
    provider: providerIdentityForCopy(row, row),
    userId,
    repairExisting: true,
  });
};

/**
 * Repair only reply rows with exactly one same-account RFC parent. `client` is
 * deliberately injectable so the decision/counters can be regression-tested
 * without PostgreSQL. A dry run uses per-row savepoints and leaves no writes.
 */
export async function repairOrphanedRepliesWithClient(
  client: RepairClient,
  { userId, accountId = null, limit = 100, dryRun = true }: OrphanedReplyRepairOptions,
  apply: ApplyRepair = defaultApply,
): Promise<OrphanedReplyRepairCounters> {
  const counters = EMPTY_COUNTERS();
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 100, 1_000));
  const candidates = await client.query<RepairRow>(
    `SELECT m.*, EXISTS (
       SELECT 1
         FROM conversations c
        WHERE c.id = m.conversation_id AND c.user_id = a.user_id AND c.manually_locked = true
     ) OR EXISTS (
       SELECT 1
         FROM conversation_overrides o
        WHERE o.user_id = a.user_id AND o.account_id = m.account_id
          AND (o.conversation_id = m.conversation_id OR o.logical_message_id = m.logical_message_id)
     ) AS manual_protected
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1
        AND ($2::uuid IS NULL OR m.account_id = $2)
         -- Repair only rows missing a Conversation v2 projection. Rows already
         -- attached to a conversation can reflect an intentional grouping.
         AND (m.conversation_id IS NULL OR m.logical_message_id IS NULL)
        AND m.is_deleted = false
        AND (m.in_reply_to IS NOT NULL OR m.thread_references IS NOT NULL)
      ORDER BY m.date ASC NULLS LAST, m.id ASC
      LIMIT $3`,
    [userId, accountId, boundedLimit],
  );

  for (const child of candidates.rows) {
    counters.scanned += 1;
    if (child.manual_protected) {
      counters.protected_by_manual_override += 1;
      continue;
    }
    const headers = replyParentHeaders(child);
    if (headers.length !== 1) {
      counters.missing_parent += 1;
      continue;
    }
    const parents = await client.query<RepairRow>(
      `SELECT m.*, EXISTS (
         SELECT 1 FROM conversations c
          WHERE c.id = m.conversation_id AND c.user_id = $3 AND c.manually_locked = true
       ) OR EXISTS (
         SELECT 1 FROM conversation_overrides o
          WHERE o.user_id = $3 AND o.account_id = m.account_id
            AND (o.conversation_id = m.conversation_id OR o.logical_message_id = m.logical_message_id)
       ) AS manual_protected
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
        WHERE m.account_id = $1 AND a.user_id = $3 AND m.is_deleted = false
          AND m.message_id = $2
        ORDER BY m.date DESC NULLS LAST, m.id DESC
        LIMIT 2`,
      [child.account_id, headers[0], userId],
    );
    if (parents.rows.length === 0) {
      counters.missing_parent += 1;
      continue;
    }
    if (parents.rows.length !== 1) {
      counters.ambiguous += 1;
      continue;
    }
    if (parents.rows[0].manual_protected) {
      counters.protected_by_manual_override += 1;
      continue;
    }

    const before = conversationSnapshot(child);
    if (dryRun) await client.query('SAVEPOINT orphaned_reply_repair_dry_run');
    try {
      await apply(client, child, userId);
      const after = await client.query<RepairRow>(
        'SELECT conversation_id, logical_message_id FROM messages WHERE id = $1', [child.id],
      );
      if (conversationSnapshot(after.rows[0]) !== before) counters.repaired += 1;
      if (dryRun) await client.query('ROLLBACK TO SAVEPOINT orphaned_reply_repair_dry_run');
    } catch (error) {
      if (dryRun) await client.query('ROLLBACK TO SAVEPOINT orphaned_reply_repair_dry_run');
      throw error;
    }
  }
  return counters;
}

/** Transactional bounded job entry point for CLI/admin scheduling. */
export async function repairOrphanedReplies(options: OrphanedReplyRepairOptions): Promise<OrphanedReplyRepairCounters> {
  const client = await pool.connect();
  const dryRun = options.dryRun !== false;
  try {
    await client.query('BEGIN');
    const counters = await repairOrphanedRepliesWithClient(client, { ...options, dryRun });
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return counters;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
