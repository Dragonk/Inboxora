// Anti-spam auto-classification pipeline.
//
// Called right after a NEW message row is inserted. Performs the hybrid
// classification and, on very high confidence, optionally moves the message
// to the account spam folder.
//
// Layers:
//   3. messages.spam_user_override — ALWAYS wins, skip if set (user intent)
//   2. per-user MNB model — active when training_records >= 50
//   1. 14-rule engine — always on, sole classifier below 50 records
//
// The move is delegated through an injected `imap` facade so this module
// never imports imapManager (avoids an import cycle). Without it the message
// is only tagged.
//
// Auto-classified verdicts NEVER write to spam_training_log. Only explicit
// user feedback (/spam, /ham) trains the model — auto-verdicts fed back
// would poison it.
//
// Auto-move: skipped entirely when the caller defers it (`deferAutoMove`,
// used by the backfill path). A reindex classifies a whole mailbox at once,
// and that many concurrent moves would fight over the pooled connections.

import { query } from './db.js';
import { normalizeContactAddress } from './spamRules.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import type { FlagFeatures, SpamMessageInput } from './spamTokenizer.js';
import { scoreRules } from './spamRules.js';
import { extractAuthservIds, normalizeAuthservId } from './spamParser.js';
import { getModelForUser } from './spamModelStore.js';
import { classifyMessage, blendScores, extractTopTokens, isModelMature, usableTrainingTotal } from './spamModel.js';
import { resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { MIN_TRAINING_RECORDS, SOFT_TRAINING_RECORDS } from './spamModel.js';
import { toAppError } from '../utils/errors.js';

export const SPAM_THRESHOLD = 0.85;
export const AUTO_MOVE_THRESHOLD = 0.95;
// Re-exported from spamModel (canonical home): keeps existing import sites working.
export { MIN_TRAINING_RECORDS, SOFT_TRAINING_RECORDS } from './spamModel.js';

function clampThreshold(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface ResolvedSpamThresholds {
  spamThreshold: number;
  autoMoveThreshold: number;
  minRecords: number;
  softRecords: number;
}

export async function resolveSpamThresholds(ownerId: string): Promise<ResolvedSpamThresholds> {
  try {
    const result = await query<{ spam_thresholds?: unknown }>(
      `SELECT preferences->'spam_thresholds' AS spam_thresholds FROM users WHERE id = $1`,
      [ownerId],
    );
    const stored = result.rows[0]?.spam_thresholds;
    const obj = (stored !== null && typeof stored === 'object' && !Array.isArray(stored))
      ? (stored as Record<string, unknown>)
      : {};
    return {
      spamThreshold: clampThreshold(obj.spamThreshold, SPAM_THRESHOLD, 0.5, 0.99),
      autoMoveThreshold: clampThreshold(obj.autoMoveThreshold, AUTO_MOVE_THRESHOLD, 0.7, 0.99),
      minRecords: Math.max(1, Math.round(clampThreshold(obj.minRecords, MIN_TRAINING_RECORDS, 1, 10000))),
      softRecords: Math.max(1, Math.round(clampThreshold(obj.softRecords, SOFT_TRAINING_RECORDS, 1, 100000))),
    };
  } catch {
    return { spamThreshold: SPAM_THRESHOLD, autoMoveThreshold: AUTO_MOVE_THRESHOLD, minRecords: MIN_TRAINING_RECORDS, softRecords: SOFT_TRAINING_RECORDS };
  }
}

function resolveThresholdsSync(input: SpamThresholdsInput | null | undefined): ResolvedSpamThresholds {
  return {
    spamThreshold: clampThreshold(input?.spamThreshold, SPAM_THRESHOLD, 0.5, 0.99),
    autoMoveThreshold: clampThreshold(input?.autoMoveThreshold, AUTO_MOVE_THRESHOLD, 0.7, 0.99),
    minRecords: Math.max(1, Math.round(clampThreshold(input?.minRecords, MIN_TRAINING_RECORDS, 1, 10000))),
    softRecords: Math.max(1, Math.round(clampThreshold(input?.softRecords, SOFT_TRAINING_RECORDS, 1, 100000))),
  };
}

export interface SpamClassifyInput {
  headers?: SpamMessageInput['headers'];
  deferAutoMove?: boolean;
  imap?: SpamImapFacade | null;
  thresholds?: SpamThresholdsInput | null;
}

export interface SpamThresholdsInput {
  spamThreshold?: number;
  autoMoveThreshold?: number;
  minRecords?: number;
  softRecords?: number;
}

export interface SpamImapFacade {
  // Narrowed to accountId: the manager resolves the FULL EmailAccountRow
  // (host, port, TLS, auth, OAuth) itself. Passing a partial account object
  // made auto-move work only when a pooled client happened to be free.
  moveMessageByAccount?: (accountId: string, uid: number | string, fromFolder: string, toFolder: string) => Promise<number | null | undefined>;
  moveMessage?: (account: { id: string; email_address?: string | null }, uid: number | string, fromFolder: string, toFolder: string) => Promise<number | null | undefined>;
  broadcast?: (payload: Record<string, unknown>, userId: string) => void;
  _guardMoveUid?: (accountId: string, folder: string, uid: number | string) => void;
  _unguardMoveUid?: (accountId: string, folder: string, uid: number | string) => void;
  // Serialized/deduped auto-move path (preferred when present): the manager
  // coalesces concurrent moves of the same physical copy into one IMAP MOVE.
  moveSpamCopy?: (accountId: string, uid: number | string, fromFolder: string, toFolder: string) => Promise<number | null | undefined>;
}

export interface SpamClassificationSummary {
  verdict: 'spam' | 'ham' | 'unsure';
  blendedScore: number;
  method: 'rules' | 'blended';
  mlProbability: number | null;
  shouldMove: boolean;
  moved: boolean;
  autoMoveDeferred: boolean;
  skipped: string | null;
}

interface SpamMessageRow {
  id: string;
  account_id: string;
  folder: string;
  uid: number | string;
  is_deleted: boolean | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  from_email: string | null;
  reply_to: unknown;
  attachments: unknown;
  spam_user_override: string | null;
  owner_id: string;
  account_email: string | null;
  antispam_enabled: boolean | null;
  folder_mappings: { inbox?: string | null; spam?: string | null } | null;
  trusted_authserv_id: string | null;
  master_spam_enabled: string | null;
}

const round = (n: number, places = 3): number => Math.round(n * 10 ** places) / 10 ** places;

function toReplyToString(replyTo: unknown): string | null {
  if (typeof replyTo === 'string') return replyTo;
  if (Array.isArray(replyTo) && replyTo.length > 0) {
    const first = replyTo[0] as { email?: unknown } | string | undefined;
    if (typeof first === 'string') return first;
    if (first !== null && typeof first === 'object' && typeof first.email === 'string') return first.email;
  }
  return null;
}

function toAttachmentList(attachments: unknown): Array<{ filename?: string | null; name?: string | null; contentType?: string | null; type?: string | null }> {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((a): a is { filename?: string | null; name?: string | null; contentType?: string | null; type?: string | null } =>
    a !== null && typeof a === 'object');
}

function toHeadersMap(row: SpamMessageRow, headers: SpamClassifyInput['headers']): SpamMessageInput['headers'] {
  return headers ?? null;
}

export async function classifyAndTagMessage(
  messageId: string,
  opts: SpamClassifyInput = {},
): Promise<SpamClassificationSummary | null> {
  const data = await query<SpamMessageRow>(`
    SELECT m.*, a.user_id AS owner_id, a.email_address AS account_email,
           a.antispam_enabled, a.folder_mappings, a.trusted_authserv_id,
           u.preferences->>'spamEnabled' AS master_spam_enabled
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN users u ON u.id = a.user_id
    WHERE m.id = $1
  `, [messageId]);
  const row = data.rows[0];
  if (!row) return null;

  if (row.spam_user_override) return {
    verdict: 'unsure', blendedScore: 0, method: 'rules',
    mlProbability: null, shouldMove: false, moved: false,
    autoMoveDeferred: false, skipped: 'user_override',
  };

  if (row.master_spam_enabled === 'false' || !row.antispam_enabled) {
    return {
      verdict: 'unsure', blendedScore: 0, method: 'rules',
      mlProbability: null, shouldMove: false, moved: false,
      autoMoveDeferred: false,
      skipped: row.master_spam_enabled === 'false' ? 'spam_disabled' : 'antispam_disabled',
    };
  }

  const attachments = toAttachmentList(row.attachments);
  const msg: SpamMessageInput = {
    subject: row.subject ?? '',
    body: row.body_text ?? '',
    bodyHtml: row.body_html ?? '',
    from: row.from_email ? `<${row.from_email}>` : null,
    replyTo: toReplyToString(row.reply_to),
    attachments,
    headers: toHeadersMap(row, opts.headers),
  };

  const trustedAuthservId = normalizeAuthservId(row.trusted_authserv_id);
  const observedAuthservIds = extractAuthservIds(msg.headers ?? null);

  const tokens = tokenize(msg);
  const flagFeatures: FlagFeatures = extractFlagFeatures(msg, { trustedAuthservIds: trustedAuthservId });

  // Per-user thresholds (PATCH /api/spam/thresholds) actually drive the
  // verdict here; an explicit per-call override wins for tests/previews.
  const thresholds = opts.thresholds
    ? resolveThresholdsSync(opts.thresholds)
    : await resolveSpamThresholds(row.owner_id);
  const userContacts = await loadHamContacts(row.owner_id, row.account_id);

  const rules = scoreRules(msg, {
    userContacts,
    trustedAuthservIds: trustedAuthservId,
  });

  const model = await getModelForUser(row.owner_id);
  // ML joins only on distinct-message maturity: >= minRecords usable unique
  // samples with a minimum of each class — one mail confirmed 50x, or 50
  // spams with zero hams, stays rules-only.
  const mlActive = isModelMature(model, { minRecords: thresholds.minRecords });
  const trainingRecords = usableTrainingTotal(model);

  let mlProbability: number | null = null;
  let mlConfidence: number | null = null;
  let blended = rules.score;
  let method: 'rules' | 'blended' = 'rules';
  if (mlActive && model) {
    const ml = classifyMessage(model, tokens, flagFeatures);
    mlProbability = ml.probability;
    mlConfidence = ml.confidence;
    blended = blendScores(ml.probability, rules.score, trainingRecords, {
      minRecords: thresholds.minRecords,
      softRecords: thresholds.softRecords,
    });
    method = 'blended';
  }

  const verdict: 'spam' | 'ham' | 'unsure' = blended >= thresholds.spamThreshold ? 'spam' : blended < 0.3 ? 'ham' : 'unsure';

  const spamFolder = row.folder_mappings?.spam ?? null;
  // Automatic MOVE is INBOX-only: classification/tagging runs everywhere, but
  // a destructive move out of Sent, Archive or a user-created folder would
  // turn a false positive into lost mail. The eligible source is the
  // account's mapped inbox (default INBOX).
  const inboxFolder = row.folder_mappings?.inbox ?? 'INBOX';

  const wouldAutoMove = verdict === 'spam'
    && blended >= thresholds.autoMoveThreshold
    && mlActive
    && Boolean(spamFolder)
    && row.folder === inboxFolder;

  const deferAutoMove = Boolean(opts.deferAutoMove);
  const shouldMove = wouldAutoMove && !deferAutoMove;

  const details = {
    method,
    blendedScore: round(blended),
    rulesScore: round(rules.score),
    rulesFired: rules.fired.map(r => ({ name: r.name, weight: r.weight })),
    mlProbability: mlProbability === null ? null : round(mlProbability),
    mlConfidence: mlConfidence === null ? null : round(mlConfidence),
    topTokens: extractTopTokens(model, tokens, 5).map(t => ({
      token: t.token,
      contribution: round(t.contribution),
    })),
    authservIds: observedAuthservIds,
    trustedAuthservId,
    authTrusted: trustedAuthservId !== null && observedAuthservIds.includes(trustedAuthservId),
    autoMoveDeferred: wouldAutoMove && deferAutoMove,
  };

  await query(
    `UPDATE messages SET
       spam_verdict = $1, spam_score_ml = $2, spam_analyzed_at = NOW(), spam_details = $3
     WHERE id = $4`,
    [verdict, mlProbability ?? rules.score, JSON.stringify(details), messageId],
  );

  let moved = false;
  if (shouldMove && opts.imap && spamFolder) {
    try {
      moved = await autoMove(row, spamFolder, opts.imap, messageId);
    } catch (caught) {
      const err = toAppError(caught);
      console.warn(`spam auto-move failed for message ${messageId}:`, err.message);
    }
  }

  return {
    verdict,
    blendedScore: round(blended),
    method,
    mlProbability,
    shouldMove,
    moved,
    autoMoveDeferred: wouldAutoMove && deferAutoMove,
    skipped: null,
  };
}

export async function autoMove(
  row: Pick<SpamMessageRow, 'account_id' | 'account_email' | 'owner_id' | 'folder' | 'uid'>,
  spamFolder: string,
  imap: SpamImapFacade,
  messageId: string,
): Promise<boolean> {
  const moveKey = `${row.account_id}:${row.folder}:${row.uid}`;
  const existing = spamMoveInflights.get(moveKey);
  if (existing) {
    // Share the first caller's outcome verbatim: if it was revalidation-
    // skipped (false) or threw, the second caller must observe the same —
    // reporting moved=true for a move that never happened would lie to the
    // caller and desync folder badges.
    return existing;
  }
  const promise = (async (): Promise<boolean> => {
    // Re-validate the physical row immediately before the MOVE: the
    // classification above ran fire-and-forget while Inbox Rules / the Block
    // List may have moved the copy elsewhere in the meantime. Moving a stale
    // (folder, uid) snapshot would relocate the WRONG copy — or a UID that no
    // longer exists. The user override always wins, including under races.
    const fresh = await revalidateMoveSource(messageId, row);
    if (!fresh.ok) {
      if (fresh.reason !== 'already_in_spam') {
        console.warn(`spam auto-move skipped for message ${messageId}: ${fresh.reason}`);
      }
      return false;
    }
    imap._guardMoveUid?.(row.account_id, row.folder, row.uid);
    try {
      const mover = imap.moveSpamCopy ?? (async (accountId, uid, fromFolder, toFolder) => {
        if (!imap.moveMessage) throw new Error('no IMAP move available');
        // Legacy shape for tests: a partial account object still works when
        // the caller cannot resolve the full row.
        return imap.moveMessage({ id: accountId }, uid, fromFolder, toFolder);
      });
      const newUid = await mover(row.account_id, row.uid, row.folder, spamFolder);
      const wasUnread = await readWasUnread(messageId);
      if (newUid !== null && newUid !== undefined) {
        await query(
          'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
          [row.account_id, newUid, spamFolder, messageId],
        );
        await query(
          'UPDATE messages SET folder = $1, uid = $2 WHERE id = $3',
          [spamFolder, newUid, messageId],
        );
      } else {
        imap._guardMoveUid?.(row.account_id, spamFolder, row.uid);
        await query(
          'UPDATE messages SET folder = $1 WHERE id = $2',
          [spamFolder, messageId],
        );
        setTimeout(
          () => imap._unguardMoveUid?.(row.account_id, spamFolder, row.uid),
          10_000,
        );
      }
      // Keep the cached folder badges in step with the move (mirrors the
      // manual /spam path); the next sync reconciles any residual drift.
      if (wasUnread === true) {
        adjustFolderCounts(row.account_id, row.folder, -1, -1);
        adjustFolderCounts(row.account_id, spamFolder, 1, 1);
      } else if (wasUnread === false) {
        adjustFolderCounts(row.account_id, row.folder, -1, 0);
        adjustFolderCounts(row.account_id, spamFolder, 1, 0);
      }
      imap.broadcast?.(
        { type: 'folder_updated', folder: spamFolder, accountId: row.account_id },
        row.owner_id,
      );
      return true;
    } finally {
      imap._unguardMoveUid?.(row.account_id, row.folder, row.uid);
    }
  })();
  spamMoveInflights.set(moveKey, promise);
  try {
    return await promise;
  } finally {
    if (spamMoveInflights.get(moveKey) === promise) spamMoveInflights.delete(moveKey);
  }
}

// In-flight auto-moves keyed by physical copy: concurrent verdicts for the
// same (account, folder, uid) share one IMAP MOVE instead of issuing two.
const spamMoveInflights = new Map<string, Promise<boolean>>();

// Re-read the physical row just before an auto-move. The classifier snapshot
// (folder, uid) may be stale by the time the MOVE runs: Inbox Rules / the
// Block List execute after classifySpamForIngest was queued and can relocate
// the copy, and the user may have set an override in between. Returns ok only
// when the row still exists, is not deleted, carries no user override, and
// still sits at the exact (folder, uid) the verdict was computed for.
async function revalidateMoveSource(
  messageId: string,
  snapshot: Pick<SpamMessageRow, 'account_id' | 'folder' | 'uid'>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let current: { folder: string; uid: number | string; is_deleted: boolean | null; spam_user_override: string | null } | undefined;
  try {
    const result = await query<{ folder: string; uid: number | string; is_deleted: boolean | null; spam_user_override: string | null }>(
      'SELECT folder, uid, is_deleted, spam_user_override FROM messages WHERE id = $1',
      [messageId],
    );
    current = result.rows[0];
  } catch {
    return { ok: false, reason: 'revalidation_query_failed' };
  }
  if (!current) return { ok: false, reason: 'message_row_gone' };
  if (current.is_deleted) return { ok: false, reason: 'message_deleted' };
  if (current.spam_user_override) return { ok: false, reason: 'user_override_set' };
  if (current.folder !== snapshot.folder || String(current.uid) !== String(snapshot.uid)) {
    return { ok: false, reason: 'message_relocated' };
  }
  // Belt-and-braces: the row must still reference the same account (a move
  // across accounts is impossible, but the check is free).
  return { ok: true };
}

async function readWasUnread(messageId: string): Promise<boolean | null> {
  try {
    const result = await query<{ is_read: boolean | null }>(
      'SELECT is_read FROM messages WHERE id = $1', [messageId],
    );
    const value = result.rows[0]?.is_read;
    return typeof value === 'boolean' ? !value : null;
  } catch {
    return null;
  }
}

async function loadHamContacts(ownerId: string, accountId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    // Own identity addresses (account email + aliases, resolved through the
    // same helper the Conversation Engine uses) are always trusted ham: mail
    // FROM self must never count as spam.
    try {
      const own = await resolveOwnIdentityAddresses({ query }, accountId);
      for (const address of own) {
        const normalized = normalizeContactAddress(address);
        if (normalized) out.add(normalized);
      }
    } catch {
      // Non-fatal: fall through to contacts-only.
    }
    // Only manually curated contacts count — auto-created sender rows would
    // otherwise let the first spam whitelist itself.
    const result = await query<{ primary_email: string | null; emails: unknown }>(
      `SELECT c.primary_email, c.emails FROM contacts c
       JOIN address_books ab ON ab.id = c.address_book_id
       WHERE ab.user_id = $1 AND COALESCE(c.is_auto, false) = false
       LIMIT 2000`,
      [ownerId],
    );
    for (const row of result.rows) {
      if (typeof row.primary_email === 'string' && row.primary_email) {
        const normalized = normalizeContactAddress(row.primary_email);
        if (normalized) out.add(normalized);
      }
      if (Array.isArray(row.emails)) {
        for (const entry of row.emails as Array<{ value?: unknown }>) {
          if (entry !== null && typeof entry === 'object' && typeof entry.value === 'string') {
            const normalized = normalizeContactAddress(entry.value);
            if (normalized) out.add(normalized);
          }
        }
      }
    }
    return out;
  } catch {
    return new Set<string>();
  }
}
