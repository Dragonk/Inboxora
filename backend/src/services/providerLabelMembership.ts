import { query } from './db.js';

/**
 * Whether a mailbox's label membership is complete (MAIL-02).
 *
 * The membership table is written by the Gmail synchronisation and read by nothing yet, on purpose: the reads
 * change together with the model, and writing first is what makes that change verifiable. This is the check that
 * makes it verifiable **before** the reads depend on it — it compares what each message's own `provider_labels`
 * says against the rows recorded for it, so an account whose membership was never written (synchronised before
 * migration `0116`, or by a path that does not record it) is visible rather than silently empty.
 *
 * A mailbox should report `complete` for every message and `missingRows` of zero. Anything else is answered with
 * the account and the counts, not with a guess about which of the two sources is right: the provider's label set
 * is the authority, and a message whose rows disagree is one the next synchronisation will rewrite.
 */
export interface LabelMembershipReport {
  accountId: string;
  /** Provider messages in this account, as the membership is measured against. */
  messages: number;
  /** Membership rows recorded for them. */
  rows: number;
  /** Messages whose own label set has labels the membership does not have. */
  missingRows: number;
  /** Messages whose membership holds labels the message no longer carries. */
  extraRows: number;
  /** Provider messages with no membership at all. */
  unrecorded: number;
}

/** One account's membership health, computed from the two sources rather than from either alone. */
export async function labelMembershipReport(accountId: string): Promise<LabelMembershipReport> {
  const result = await query<{
    messages: string; rows: string; missing_rows: string; extra_rows: string; unrecorded: string;
  }>(
    `WITH provider_labels AS (
       SELECT m.id,
              COALESCE(m.provider_labels, ARRAY[]::text[]) AS labels,
              ARRAY(SELECT label_id FROM message_labels WHERE message_id = m.id) AS recorded
         FROM messages m
        WHERE m.account_id = $1 AND m.provider_message_id IS NOT NULL
     )
     SELECT
       COUNT(*)::text AS messages,
       (SELECT COUNT(*)::text FROM message_labels WHERE account_id = $1) AS rows,
       -- Containment, not equality: the two sides are unordered label sets, and only "the message carries a label
       -- the membership does not" (or the reverse) is a disagreement.
       COUNT(*) FILTER (WHERE NOT (labels <@ recorded))::text AS missing_rows,
       COUNT(*) FILTER (WHERE NOT (recorded <@ labels))::text AS extra_rows,
       COUNT(*) FILTER (WHERE cardinality(recorded) = 0 AND cardinality(labels) > 0)::text AS unrecorded
       FROM provider_labels`,
    [accountId],
  );
  const row = result.rows[0];
  return {
    accountId,
    messages: Number(row?.messages ?? 0),
    rows: Number(row?.rows ?? 0),
    missingRows: Number(row?.missing_rows ?? 0),
    extraRows: Number(row?.extra_rows ?? 0),
    unrecorded: Number(row?.unrecorded ?? 0),
  };
}
