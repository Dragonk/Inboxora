import { query, withTransaction } from '../../db.js';
import { graphGetWithHeaders, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';

/**
 * Translating an existing mailbox's Graph message ids (GRAPH-04).
 *
 * Graph answers with two kinds of id: the default, which can change when an item moves between folders, and the
 * **immutable** one, which is stable and is what a local store should record. Asking for immutable ids is a
 * per-request preference (`Prefer: IdType="ImmutableId"`), and switching it on for a mailbox whose rows already
 * hold default ids would make every stored id unrecognisable: the next synchronisation would treat each message as
 * new (duplicating it) and the existing rows would be orphaned — including their annotations.
 *
 * So the preference stays **off** in the synchronisation, and this module is the controlled migration that has to
 * happen first: it asks Graph for each stored message's immutable id and records the mapping. It is deliberately
 * separate from the sync path and dry-runnable, because it is the step that rewrites identity for a whole mailbox.
 *
 * The preference is not enabled anywhere by this file; a mailbox is only ever read under it here, one message at a
 * time, with what Graph returns compared against what is stored before anything is written.
 */
const IMMUTABLE_ID_PREFERENCE = 'IdType="ImmutableId"';

/** The immutable id Graph reports for one message, or null when it reports none. */
export async function immutableIdForMessage(api: GraphApiOptions, providerMessageId: string): Promise<string | null> {
  const message = await graphGetWithHeaders<{ id?: string | null }>(
    api,
    graphUrl(`/me/messages/${encodeURIComponent(providerMessageId)}`, { $select: 'id' }),
    { prefer: IMMUTABLE_ID_PREFERENCE },
  );
  const id = typeof message?.id === 'string' ? message.id.trim() : '';
  return id || null;
}

export interface GraphIdTranslationPlan {
  /** Rows whose stored id differs from the immutable id Graph reported. */
  changes: Array<{ messageId: string; from: string; to: string }>;
  /** Rows already carrying the immutable id. */
  unchanged: number;
  /** Rows Graph no longer holds (or answered without an id); they are left exactly as they are. */
  unavailable: Array<{ messageId: string; providerMessageId: string }>;
}

/**
 * Work out the translation for one connection's mailboxes without writing anything.
 *
 * A message Graph no longer holds is reported rather than removed or guessed at: this migration's only job is
 * identity, and a row whose provider object is gone is a reconciliation question, not this one's.
 */
export async function planGraphMessageIdTranslation(input: {
  userId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: typeof fetch;
  /** Cap on how many rows one plan reads, so a large mailbox is migrated in deliberate batches. */
  limit?: number;
}): Promise<GraphIdTranslationPlan> {
  const rows = await query<{ id: string; provider_message_id: string; account_id: string }>(
    `SELECT m.id, m.provider_message_id, m.account_id
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.provider_connection_id = $1 AND a.user_id = $2 AND m.provider_message_id IS NOT NULL
      ORDER BY m.synced_at DESC NULLS LAST, m.id
      LIMIT $3`,
    [input.connectionId, input.userId, input.limit ?? 200],
  );

  const plan: GraphIdTranslationPlan = { changes: [], unchanged: 0, unavailable: [] };
  for (const row of rows.rows) {
    const api: GraphApiOptions = {
      userId: input.userId,
      connectionId: input.connectionId,
      ...(input.config ? { config: input.config } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };
    let immutable: string | null;
    try {
      immutable = await immutableIdForMessage(api, row.provider_message_id);
    } catch {
      // A message Graph will not answer for is reported, not written: the sync's own reconcile decides what to do
      // about a message that no longer exists.
      immutable = null;
    }
    if (!immutable) {
      plan.unavailable.push({ messageId: row.id, providerMessageId: row.provider_message_id });
      continue;
    }
    if (immutable === row.provider_message_id) plan.unchanged += 1;
    else plan.changes.push({ messageId: row.id, from: row.provider_message_id, to: immutable });
  }
  return plan;
}

/**
 * Apply a plan: record each message's immutable id.
 *
 * One transaction, and a row whose new id is already taken by another row of the same account is skipped rather
 * than allowed to violate the identity it would collide with — the caller sees it in `skipped` and can reconcile.
 */
export async function applyGraphMessageIdTranslation(plan: GraphIdTranslationPlan): Promise<{ updated: number; skipped: number }> {
  if (plan.changes.length === 0) return { updated: 0, skipped: 0 };
  return withTransaction(async (client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> }) => {
    let updated = 0;
    let skipped = 0;
    for (const change of plan.changes) {
      const result = await client.query(
        `UPDATE messages m SET provider_message_id = $2, synced_at = m.synced_at
          WHERE m.id = $1
            AND NOT EXISTS (
              SELECT 1 FROM messages other
               WHERE other.account_id = m.account_id AND other.provider_message_id = $2 AND other.id <> m.id
            )`,
        [change.messageId, change.to],
      );
      if ((result.rowCount ?? 0) > 0) updated += 1;
      else skipped += 1;
    }
    return { updated, skipped };
  });
}
