import type { PoolClient } from 'pg';
import { bindVerifiedLegacyGraphMessage, markGraphBindingNeedsReview } from './graphLegacyMessageBindings.js';

export interface GraphLegacyBindingRepairResult {
  bound: number;
  needsReview: number;
  missingNative: number;
  failed: number;
  scanned: number;
  /** Last legacy UUID durably examined; pass it to resume. */
  checkpoint: string | null;
}

/**
 * Repair only pre-existing local pairs after a Graph cutover.
 *
 * This is intentionally local and bounded: it neither calls Graph, advances sync cursors, deletes messages, nor
 * writes a provider id onto an IMAP-era row. A failure leaves its row out of the checkpoint so the next run retries
 * it rather than silently skipping uncertain work.
 */
export async function repairExistingGraphLegacyMessageBindings(
  client: PoolClient,
  input: { userId: string; accountId: string; connectionId: string; checkpoint?: string | null; limit?: number },
): Promise<GraphLegacyBindingRepairResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const legacy = await client.query<{ id: string; message_id: string | null; from_email: string | null; date: Date | null }>(
    `SELECT m.id, m.message_id, m.from_email, m.date FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE m.account_id = $1 AND a.user_id = $2 AND a.provider_connection_id = $3
        AND NULLIF(BTRIM(m.provider_message_id), '') IS NULL
        AND ($4::uuid IS NULL OR m.id > $4::uuid)
      ORDER BY m.id LIMIT $5`,
    [input.accountId, input.userId, input.connectionId, input.checkpoint ?? null, limit],
  );
  const result: GraphLegacyBindingRepairResult = {
    bound: 0, needsReview: 0, missingNative: 0, failed: 0, scanned: 0, checkpoint: input.checkpoint ?? null,
  };
  for (const row of legacy.rows) {
    try {
      const native = await client.query<{ id: string; provider_message_id: string }>(
        `SELECT id, provider_message_id FROM messages
          WHERE account_id = $1 AND NULLIF(BTRIM(provider_message_id), '') IS NOT NULL
            AND NULLIF(BTRIM(message_id), '') = NULLIF(BTRIM($2), '')
            AND from_email IS NOT DISTINCT FROM $3 AND date IS NOT DISTINCT FROM $4::timestamptz
          ORDER BY id LIMIT 2`,
        [input.accountId, row.message_id, row.from_email, row.date],
      );
      if (native.rows.length === 0) result.missingNative += 1;
      else if (native.rows.length !== 1) {
        await markGraphBindingNeedsReview(client, {
          legacyMessageId: row.id, canonicalMessageId: native.rows[0]!.id, accountId: input.accountId,
          connectionId: input.connectionId, reason: 'multiple_native_candidates',
        });
        result.needsReview += 1;
      }
      else {
        const candidate = native.rows[0]!;
        const outcome = await bindVerifiedLegacyGraphMessage(client, {
          accountId: input.accountId, connectionId: input.connectionId, canonicalMessageId: candidate.id,
          providerMessageId: candidate.provider_message_id, rfcMessageId: row.message_id, fromEmail: row.from_email, date: row.date,
        });
        if (outcome === 'bound') result.bound += 1;
        else if (outcome === 'ambiguous') result.needsReview += 1;
        else result.missingNative += 1;
      }
      result.scanned += 1;
      result.checkpoint = row.id;
    } catch {
      result.failed += 1;
      break;
    }
  }
  return result;
}

/** Execute one durable repair slice after a normal account sync, without touching its delta cursor. */
export async function runGraphLegacyMessageBindingRepair(
  client: PoolClient,
  input: { userId: string; accountId: string; connectionId: string; limit?: number },
): Promise<GraphLegacyBindingRepairResult> {
  const state = await client.query<{ checkpoint: string | null }>(
    `INSERT INTO graph_legacy_message_binding_repair_state (user_id, account_id, connection_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, connection_id) DO UPDATE SET updated_at = NOW()
     RETURNING checkpoint`,
    [input.userId, input.accountId, input.connectionId],
  );
  const result = await repairExistingGraphLegacyMessageBindings(client, { ...input, checkpoint: state.rows[0]?.checkpoint ?? null });
  const status = result.failed > 0 ? 'failed' : result.scanned === 0 ? 'complete' : 'pending';
  await client.query(
    `UPDATE graph_legacy_message_binding_repair_state
        SET checkpoint = $3, status = $4, bound_count = bound_count + $5,
            needs_review_count = needs_review_count + $6, missing_native_count = missing_native_count + $7,
            failed_count = failed_count + $8, last_run_at = NOW(), updated_at = NOW()
      WHERE account_id = $1 AND connection_id = $2 AND user_id = $9`,
    [input.accountId, input.connectionId, result.checkpoint, status, result.bound, result.needsReview, result.missingNative, result.failed, input.userId],
  );
  return result;
}
