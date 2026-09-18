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
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import type { FlagFeatures, SpamMessageInput } from './spamTokenizer.js';
import { scoreRules } from './spamRules.js';
import { extractAuthservIds, normalizeAuthservId } from './spamParser.js';
import { getModelForUser } from './spamModelStore.js';
import { classifyMessage, blendScores, extractTopTokens } from './spamModel.js';
import { toAppError } from '../utils/errors.js';

export const SPAM_THRESHOLD = 0.85;
export const AUTO_MOVE_THRESHOLD = 0.95;
export const MIN_TRAINING_RECORDS = 50;

export interface SpamClassifyInput {
  headers?: SpamMessageInput['headers'];
  deferAutoMove?: boolean;
  imap?: SpamImapFacade | null;
}

export interface SpamImapFacade {
  moveMessage?: (account: { id: string; email_address?: string | null }, uid: number | string, fromFolder: string, toFolder: string) => Promise<number | null | undefined>;
  broadcast?: (payload: Record<string, unknown>, userId: string) => void;
  _guardMoveUid?: (accountId: string, folder: string, uid: number | string) => void;
  _unguardMoveUid?: (accountId: string, folder: string, uid: number | string) => void;
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
  folder_mappings: { spam?: string | null } | null;
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

  const rules = scoreRules(msg, {
    userContacts: new Set<string>(),
    trustedAuthservIds: trustedAuthservId,
  });

  const model = await getModelForUser(row.owner_id);
  const trainingRecords = model?.trainingRecords ?? 0;
  const mlActive = trainingRecords >= MIN_TRAINING_RECORDS;

  let mlProbability: number | null = null;
  let mlConfidence: number | null = null;
  let blended = rules.score;
  let method: 'rules' | 'blended' = 'rules';
  if (mlActive && model) {
    const ml = classifyMessage(model, tokens, flagFeatures);
    mlProbability = ml.probability;
    mlConfidence = ml.confidence;
    blended = blendScores(ml.probability, rules.score, trainingRecords);
    method = 'blended';
  }

  const verdict: 'spam' | 'ham' | 'unsure' = blended >= SPAM_THRESHOLD ? 'spam' : blended < 0.3 ? 'ham' : 'unsure';

  const spamFolder = row.folder_mappings?.spam ?? null;

  const wouldAutoMove = verdict === 'spam'
    && blended >= AUTO_MOVE_THRESHOLD
    && mlActive
    && Boolean(spamFolder)
    && row.folder !== spamFolder;

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
  imap._guardMoveUid?.(row.account_id, row.folder, row.uid);
  try {
    const account = { id: row.account_id, email_address: row.account_email ?? undefined };
    const newUid = await imap.moveMessage?.(account, row.uid, row.folder, spamFolder);
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
    imap.broadcast?.(
      { type: 'folder_updated', folder: spamFolder, accountId: row.account_id },
      row.owner_id,
    );
    return true;
  } finally {
    imap._unguardMoveUid?.(row.account_id, row.folder, row.uid);
  }
}
