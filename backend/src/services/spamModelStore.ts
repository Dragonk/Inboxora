// spam_models DB access + in-memory cache.
//
// Reads go through a per-user 5-minute in-memory cache (same pattern as the
// categorizer social-domain cache). Writes update the row and invalidate the
// cache so user feedback is reflected in <1 second.
//
// Retrains rebuild the row from spam_training_log via retrainFromRecords and
// invalidate the cache. The retrain path reads the log only — it never JOINs
// back to messages, so emptying Junk cannot silently drop training records.

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import type { SpamMessageInput, FlagFeatures } from './spamTokenizer.js';
import {
  createEmptyModel,
  updateIncremental,
  retrainFromRecords,
  pruneVocabulary,
  trainingIdentityFor,
  MODEL_VERSION,
} from './spamModel.js';
import type { SpamLabel, SpamModelState } from './spamModel.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_VOCAB_CAP = 10000;

interface ModelCacheEntry {
  model: SpamModelState | null;
  expiry: number;
}

const modelCache = new Map<string, ModelCacheEntry>();

export function invalidateModelCache(userId: string): void {
  modelCache.delete(userId);
}

interface SpamModelRow {
  vocabulary?: unknown;
  total_spam?: unknown;
  total_ham?: unknown;
  prior_spam?: unknown;
  prior_ham?: unknown;
  training_records?: unknown;
  usable_spam?: unknown;
  usable_ham?: unknown;
  model_version?: unknown;
  last_trained_at?: string | Date | null;
  decay_threshold_days?: unknown;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rowToModel(row: SpamModelRow): SpamModelState {
  const vocabulary = (row.vocabulary !== null && typeof row.vocabulary === 'object' && !Array.isArray(row.vocabulary))
    ? (row.vocabulary as SpamModelState['vocabulary'])
    : {};
  // usable_spam/usable_ham are undefined (not 0) when the columns do not exist
  // yet (pre-migration row): isModelMature falls back to the raw count until
  // the next retrain. An explicit 0 after a retrain means "no usable samples".
  const usableSpam = row.usable_spam === null || row.usable_spam === undefined ? undefined : toNumber(row.usable_spam, 0);
  const usableHam = row.usable_ham === null || row.usable_ham === undefined ? undefined : toNumber(row.usable_ham, 0);
  return {
    vocabulary,
    totalSpam: toNumber(row.total_spam, 0),
    totalHam: toNumber(row.total_ham, 0),
    priorSpam: toNumber(row.prior_spam, 0.5),
    priorHam: toNumber(row.prior_ham, 0.5),
    trainingRecords: toNumber(row.training_records, 0),
    usableSpam,
    usableHam,
    modelVersion: toNumber(row.model_version, MODEL_VERSION),
    lastTrainedAt: row.last_trained_at instanceof Date ? row.last_trained_at.toISOString() : (row.last_trained_at ?? null),
    decayThresholdDays: toNumber(row.decay_threshold_days, 90),
  };
}

export async function getModelForUser(userId: string): Promise<SpamModelState | null> {
  const cached = modelCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.model;

  const result = await query<SpamModelRow>('SELECT * FROM spam_models WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  const model = row ? rowToModel(row) : null;
  modelCache.set(userId, { model, expiry: Date.now() + CACHE_TTL_MS });
  return model;
}

function modelToParams(userId: string, model: SpamModelState): unknown[] {
  return [
    userId,
    JSON.stringify(model.vocabulary),
    model.totalSpam,
    model.totalHam,
    model.priorSpam,
    model.priorHam,
    model.trainingRecords,
    model.usableSpam ?? 0,
    model.usableHam ?? 0,
    model.decayThresholdDays ?? 90,
    model.modelVersion ?? MODEL_VERSION,
    model.lastTrainedAt ?? new Date().toISOString(),
  ];
}

export async function saveModel(userId: string, model: SpamModelState): Promise<void> {
  await query(
    `INSERT INTO spam_models
       (user_id, vocabulary, total_spam, total_ham, prior_spam, prior_ham,
        training_records, usable_spam, usable_ham, decay_threshold_days, model_version, last_trained_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (user_id) DO UPDATE SET
       vocabulary = EXCLUDED.vocabulary,
       total_spam = EXCLUDED.total_spam,
       total_ham = EXCLUDED.total_ham,
       prior_spam = EXCLUDED.prior_spam,
       prior_ham = EXCLUDED.prior_ham,
       training_records = EXCLUDED.training_records,
       usable_spam = EXCLUDED.usable_spam,
       usable_ham = EXCLUDED.usable_ham,
       model_version = EXCLUDED.model_version,
       last_trained_at = EXCLUDED.last_trained_at,
       updated_at = NOW()`,
    modelToParams(userId, model),
  );
  invalidateModelCache(userId);
}

export async function updateIncrementalForUser(
  userId: string,
  message: SpamMessageInput,
  label: SpamLabel,
  opts: { trainingIdentity?: string | null } = {},
): Promise<SpamModelState | null> {
  if (label !== 'spam' && label !== 'ham') return null;
  return runUserExclusive(userId, async () => {
    const model = (await getModelForUser(userId)) ?? createEmptyModel();
    const tokens = tokenize(message);
    const flagFeatures: FlagFeatures = extractFlagFeatures(message);
    // Repeat feedback on the SAME message (already-in-folder re-confirm)
    // still trains the vocabulary below (reinforcement), but must NOT mint a
    // new distinct usable sample: 50x confirming one mail must not mature
    // the model before the next retrain reconciles the true split. The
    // identity is the stable training_identity when the caller computed it
    // (mark-spam/ham path), else the legacy content fingerprint. A failed
    // check reads as "seen": never mint maturity on uncertain evidence.
    const seen = opts.trainingIdentity
      ? await countFeedbackForIdentity(userId, opts.trainingIdentity, label).catch(() => 1) > 0
      : await hasFeedbackForFingerprint(userId, message, label).catch(() => false);
    const updated = updateIncremental(model, tokens, flagFeatures, label, { countUsable: !seen });
    await saveModel(userId, updated);
    return updated;
  });
}

export interface ManualFeedbackInput {
  userId: string;
  accountId: string | null;
  messageIdHeader: string | null;
  messageUid: number | string | null;
  folder: string | null;
  label: SpamLabel;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  tokenCounts: Record<string, number>;
  flagFeatures: FlagFeatures;
  senderDomain: string | null;
  attachmentTypes: string[] | null;
  trainMessage: SpamMessageInput;
}

// Atomic manual feedback: training_log INSERT + incremental model update run
// inside ONE per-user serializer hold. The dedup check ("seen this identity
// with this label?") therefore cannot race a concurrent mark-spam click on
// the same mail — the second caller blocks until the first INSERTed, then
// correctly observes it as seen. Callers must await this (no fire-and-forget)
// so the HTTP response reflects the persisted decision.
export async function recordManualFeedback(input: ManualFeedbackInput): Promise<SpamModelState | null> {
  const identity = trainingIdentityFor({
    messageIdHeader: input.messageIdHeader,
    accountId: input.accountId,
    uid: input.messageUid,
    folder: input.folder,
    senderDomain: input.senderDomain,
    subject: input.subject,
    bodyText: input.bodyText,
  });
  return runUserExclusive(input.userId, async () => {
    await query(
      `INSERT INTO spam_training_log
         (user_id, account_id, message_id_header, message_uid, folder, label, source,
          subject, body_text, body_html, token_counts, flag_features, sender_domain, attachment_types,
          training_identity)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, $10, $11, $12, $13, $14)`,
      [input.userId, input.accountId, input.messageIdHeader, input.messageUid, input.folder, input.label,
       input.subject, input.bodyText, input.bodyHtml,
       JSON.stringify(input.tokenCounts), JSON.stringify(input.flagFeatures),
       input.senderDomain, input.attachmentTypes, identity],
    );
    const model = (await getModelForUser(input.userId)) ?? createEmptyModel();
    const tokens = tokenize(input.trainMessage);
    const flagFeatures: FlagFeatures = extractFlagFeatures(input.trainMessage);
    // The INSERT above is already visible in this serialized sequence, so a
    // same-identity row with this label means THIS mail was confirmed before
    // (first feedback: exactly one row — the one just inserted — still counts
    // as a new distinct sample). A failed count reads as "seen": never mint
    // maturity on uncertain evidence (the next retrain reconciles the truth).
    const priorCount = identity
      ? await countFeedbackForIdentity(input.userId, identity, input.label).catch(() => 2)
      : 0;
    const updated = updateIncremental(model, tokens, flagFeatures, input.label, { countUsable: priorCount <= 1 });
    await saveModel(input.userId, updated);
    return updated;
  });
}

async function countFeedbackForIdentity(
  userId: string,
  trainingIdentity: string,
  label: SpamLabel,
): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM spam_training_log
      WHERE user_id = $1 AND label = $2 AND training_identity = $3`,
    [userId, label, trainingIdentity],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// True when this user already gave the same label for the same message
// content. The training log carries no full From header at mark time — only
// sender_domain — so the fingerprint is (sender domain, subject, body lead):
// rows for the same physical mail share all three, while distinct mails
// differ in at least one.
async function hasFeedbackForFingerprint(
  userId: string,
  message: SpamMessageInput,
  label: SpamLabel,
): Promise<boolean> {
  const fingerprint = feedbackFingerprint(message);
  const result = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM spam_training_log
      WHERE user_id = $1 AND label = $2
        AND COALESCE(sender_domain, '') = $3
        AND COALESCE(subject, '') = $4
        AND COALESCE(LEFT(body_text, 4000), '') = $5`,
    [userId, label, fingerprint.senderDomain, fingerprint.subject, fingerprint.body],
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

function feedbackFingerprint(message: SpamMessageInput): { senderDomain: string; subject: string; body: string } {
  const norm = (value: unknown, max: number): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, max);
  const from = String(message.from ?? '');
  const at = from.lastIndexOf('@');
  const domain = at >= 0 ? from.slice(at + 1).replace(/[^a-z0-9.-]/g, '') : '';
  return {
    senderDomain: domain.slice(0, 255),
    subject: norm(message.subject, 500),
    body: norm(message.body, 4000),
  };
}

// Per-user serializer: incremental feedback and full retrains for the same
// user never interleave (lost-update race). Concurrent callers share the
// in-flight promise — the second feedback waits for the first instead of
// overwriting it with a stale read.
const userLocks = new Map<string, Promise<unknown>>();

async function runUserExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Our tail promise: resolves after fn() settles AND we released the gate.
  const tail = prev.catch(() => undefined).then(() => gate);
  // A waiter arriving while we run chains behind tail; one arriving after we
  // clean up starts from a fresh slot.
  userLocks.set(userId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Drop the slot only when no waiter chained behind us: a waiter replaced
    // the entry with its own tail, which is a different promise object.
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  }
}

export async function getAllUsersWithTraining(): Promise<string[]> {
  const result = await query<{ user_id: string }>('SELECT DISTINCT user_id FROM spam_models');
  return result.rows.map(r => r.user_id);
}

export async function getAllUsersWithTrainingLog(): Promise<string[]> {
  const result = await query<{ user_id: string }>('SELECT DISTINCT user_id FROM spam_training_log');
  return result.rows.map(r => r.user_id);
}

export interface RetrainOutcome {
  ok: boolean;
  recordsUsed: number;
  duration_ms: number;
  reason?: string;
}

export async function retrainUser(userId: string): Promise<RetrainOutcome> {
  return runUserExclusive(userId, async () => {
    const started = Date.now();
    const data = await query<{
      id: string; label: string; created_at: string | Date; account_id: string | null;
      message_id_header: string | null; message_uid: number | string | null; folder: string | null;
      training_identity: string | null;
      token_counts: Record<string, number> | null; subject: string | null;
      body_text: string | null; flag_features: FlagFeatures | null;
    }>(
      `SELECT id, label, created_at, account_id, message_id_header, message_uid, folder,
              training_identity, token_counts, flag_features, subject, body_text
       FROM spam_training_log WHERE user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    const records = data.rows;
    if (records.length === 0) {
      return { ok: false, recordsUsed: 0, duration_ms: Date.now() - started, reason: 'no_training_data' };
    }

    const existing = await getModelForUser(userId);
    const decayThresholdDays = existing?.decayThresholdDays ?? 90;

    const model = retrainFromRecords(records, decayThresholdDays);
    const pruned = Object.keys(model.vocabulary).length > MODEL_VOCAB_CAP
      ? pruneVocabulary(model, MODEL_VOCAB_CAP)
      : model;
    pruned.decayThresholdDays = decayThresholdDays;
    await saveModel(userId, pruned);
    return { ok: true, recordsUsed: records.length, duration_ms: Date.now() - started };
  });
}
