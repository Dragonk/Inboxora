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
  return {
    vocabulary,
    totalSpam: toNumber(row.total_spam, 0),
    totalHam: toNumber(row.total_ham, 0),
    priorSpam: toNumber(row.prior_spam, 0.5),
    priorHam: toNumber(row.prior_ham, 0.5),
    trainingRecords: toNumber(row.training_records, 0),
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
    model.decayThresholdDays ?? 90,
    model.modelVersion ?? MODEL_VERSION,
    model.lastTrainedAt ?? new Date().toISOString(),
  ];
}

export async function saveModel(userId: string, model: SpamModelState): Promise<void> {
  await query(
    `INSERT INTO spam_models
       (user_id, vocabulary, total_spam, total_ham, prior_spam, prior_ham,
        training_records, decay_threshold_days, model_version, last_trained_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       vocabulary = EXCLUDED.vocabulary,
       total_spam = EXCLUDED.total_spam,
       total_ham = EXCLUDED.total_ham,
       prior_spam = EXCLUDED.prior_spam,
       prior_ham = EXCLUDED.prior_ham,
       training_records = EXCLUDED.training_records,
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
): Promise<SpamModelState | null> {
  if (label !== 'spam' && label !== 'ham') return null;
  const model = (await getModelForUser(userId)) ?? createEmptyModel();
  const tokens = tokenize(message);
  const flagFeatures: FlagFeatures = extractFlagFeatures(message);
  const updated = updateIncremental(model, tokens, flagFeatures, label);
  await saveModel(userId, updated);
  return updated;
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
  const started = Date.now();
  const data = await query<{
    label: string; created_at: string | Date;
    token_counts: Record<string, number> | null; subject: string | null;
    body_text: string | null; flag_features: FlagFeatures | null;
  }>(
    `SELECT label, created_at, token_counts, flag_features, subject, body_text
     FROM spam_training_log WHERE user_id = $1`,
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
}
