// spam_models DB access + in-memory cache.
//
// Reads go through a per-user 5-minute in-memory cache (same pattern as the
// categorizer social-domain cache). Writes update the row and invalidate the
// cache so user feedback is reflected in <1 second.
//
// Retrains rebuild the row from spam_training_log via retrainFromRecords and
// invalidate the cache. The retrain path reads the log only — it never JOINs
// back to messages, so emptying Junk cannot silently drop training records.
//
// One rule holds across every path (manual feedback, incremental update, full
// retrain): ONE training identity = exactly one effective sample = the user's
// LATEST decision. A Spam→Ham correction therefore moves the sample instead
// of adding a second one, and the incrementally maintained model is
// semantically identical to the model a full retrain would produce.

import { query, withTransaction } from './db.js';
import type { DbRow } from './db.js';
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

// A statement runner. The store's internals take one so the same logic can run
// either at top level or inside a withTransaction() client, without the model
// cache ever serving a stale read mid-transaction.
type QueryExecutor = (text: string, params?: unknown[]) => Promise<{ rows: DbRow[] }>;

const topLevel: QueryExecutor = (text, params) => query<DbRow>(text, params);

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

// Cache-bypassing read: used inside transactions and by the rebuild path,
// where the 5-minute cache could otherwise serve a pre-transaction snapshot.
async function loadModel(exec: QueryExecutor, userId: string): Promise<SpamModelState | null> {
  const result = await exec('SELECT * FROM spam_models WHERE user_id = $1', [userId]);
  const row = result.rows[0] as SpamModelRow | undefined;
  return row ? rowToModel(row) : null;
}

export async function getModelForUser(userId: string): Promise<SpamModelState | null> {
  const cached = modelCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.model;

  const model = await loadModel(topLevel, userId);
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

async function saveModelWith(exec: QueryExecutor, userId: string, model: SpamModelState): Promise<void> {
  await exec(
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
}

export async function saveModel(userId: string, model: SpamModelState): Promise<void> {
  await saveModelWith(topLevel, userId, model);
  invalidateModelCache(userId);
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

// Persist one manual spam/ham decision and keep the model consistent with it.
//
// Runs under the per-user serializer AND inside one database transaction, so
// the training row and the model row commit together — the earlier comment
// claiming atomicity is now literally true. Semantics, in order:
//
//   * no previous decision for this identity → incremental add (one new
//     distinct usable sample);
//   * previous decision has the SAME label → the row is logged for audit and
//     the raw counter advances, but neither the vocabulary nor the usable
//     counters move: clicking "Spam" 100 times must not outweigh the model,
//     which a later full retrain would collapse to a single sample anyway;
//   * previous decision had the OPPOSITE label → immediate rebuild from the
//     log with latest-decision-wins, so the corrected sample is counted once
//     under its new label and the earlier wrong-label training is dropped.
//
// The flip path deliberately rebuilds instead of trying to subtract
// decay-weighted token counts: corrections are rare, and a rebuild is exactly
// what the next full retrain would compute.
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
    try {
      return await withTransaction(async (client) => {
        const exec: QueryExecutor = (text, params) => client.query<DbRow>(text, params);

        // Read the LATEST prior decision for this identity, deliberately
        // without filtering on label: a flip must be visible as a flip.
        let priorLabel: SpamLabel | null = null;
        if (identity) {
          const prior = await exec(
            `SELECT label FROM spam_training_log
              WHERE user_id = $1 AND training_identity = $2
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [input.userId, identity],
          );
          priorLabel = asSpamLabel(prior.rows[0]?.label);
        }

        await exec(
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

        if (priorLabel !== null && priorLabel === input.label) {
          // Repeat confirmation: log only. Advance the raw feedback counter so
          // it still reflects the log length, but leave the vocabulary and the
          // usable split untouched.
          const model = (await loadModel(exec, input.userId)) ?? createEmptyModel();
          const next: SpamModelState = { ...model, trainingRecords: model.trainingRecords + 1 };
          await saveModelWith(exec, input.userId, next);
          return next;
        }

        if (priorLabel === null) {
          const model = (await loadModel(exec, input.userId)) ?? createEmptyModel();
          const tokens = tokenize(input.trainMessage);
          const flagFeatures: FlagFeatures = extractFlagFeatures(input.trainMessage);
          const next = updateIncremental(model, tokens, flagFeatures, input.label, { countUsable: true });
          await saveModelWith(exec, input.userId, next);
          return next;
        }

        // Label flipped: rebuild so incremental and full retrain agree.
        const rebuilt = await rebuildModelFromLog(exec, input.userId);
        return rebuilt.model;
      });
    } finally {
      // Runs on commit, rollback and throw alike: never serve a snapshot that
      // the transaction may have changed or discarded.
      invalidateModelCache(input.userId);
    }
  });
}

function asSpamLabel(value: unknown): SpamLabel | null {
  return value === 'spam' || value === 'ham' ? value : null;
}

// Per-user serializer: feedback and full retrains for the same user never
// interleave (lost-update race). Concurrent callers share the in-flight
// promise — the second feedback waits for the first instead of overwriting it
// with a stale read. This is application-level (single process); the database
// transaction above is what makes the write itself all-or-nothing.
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

interface TrainingLogRow {
  id: string; label: string; created_at: string | Date; account_id: string | null;
  message_id_header: string | null; message_uid: number | string | null; folder: string | null;
  training_identity: string | null;
  token_counts: Record<string, number> | null; subject: string | null;
  body_text: string | null; flag_features: FlagFeatures | null;
  // Mirrors TrainingRecordInput's index signature so a row can be handed to
  // retrainFromRecords directly.
  [key: string]: unknown;
}

// Rebuild a user's model from the training log with latest-decision-wins.
// Cache-bypassing and executor-scoped so callers can run it inside their own
// transaction (label flip) or at top level (scheduled/manual retrain).
async function rebuildModelFromLog(
  exec: QueryExecutor,
  userId: string,
): Promise<{ model: SpamModelState | null; recordsUsed: number; reason?: string }> {
  const data = await exec(
    `SELECT id, label, created_at, account_id, message_id_header, message_uid, folder,
            training_identity, token_counts, flag_features, subject, body_text
     FROM spam_training_log WHERE user_id = $1
     ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  const records = data.rows as unknown as TrainingLogRow[];
  if (records.length === 0) return { model: null, recordsUsed: 0, reason: 'no_training_data' };

  const existing = await loadModel(exec, userId);
  const decayThresholdDays = existing?.decayThresholdDays ?? 90;

  const model = retrainFromRecords(records, decayThresholdDays);
  const pruned = Object.keys(model.vocabulary).length > MODEL_VOCAB_CAP
    ? pruneVocabulary(model, MODEL_VOCAB_CAP)
    : model;
  pruned.decayThresholdDays = decayThresholdDays;
  await saveModelWith(exec, userId, pruned);
  return { model: pruned, recordsUsed: records.length };
}

export async function retrainUser(userId: string): Promise<RetrainOutcome> {
  const started = Date.now();
  const outcome = await runUserExclusive(userId, async () => {
    const rebuilt = await rebuildModelFromLog(topLevel, userId);
    if (!rebuilt.model) {
      return { ok: false, recordsUsed: 0, duration_ms: Date.now() - started, reason: rebuilt.reason ?? 'no_training_data' };
    }
    return { ok: true, recordsUsed: rebuilt.recordsUsed, duration_ms: Date.now() - started };
  });
  invalidateModelCache(userId);
  return outcome;
}
