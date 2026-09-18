// Multinomial Naive Bayes spam classifier — pure logic, no I/O.
//
// Per-user JSONB vocabulary {word: {spam, ham}} with running counts plus
// cached totals and priors, persisted in spam_models. Scoring in
// log-probability space with Laplace smoothing. Auth flags carry fixed
// asymmetric weights (not learned counts); heuristic flags are learned as
// special __tokens__.
//
// Adapted from upstream MailFlow v0.2 for Inboxora (strict TypeScript).

import { tokenize } from './spamTokenizer.js';
import type { FlagFeatures } from './spamTokenizer.js';

export const MODEL_VERSION = 1;
export const ALPHA = 1.0;

export const AUTH_WEIGHTS = {
  dkim: { fail: 0.7, pass: -0.2 },
  spf: { fail: 0.7, pass: -0.1 },
  dmarc: { fail: 0.5, pass: -0.1 },
} as const;

export const FLAG_TOKENS = {
  has_attachment: '__has_attachment__',
  attachment_is_executable: '__attachment_is_executable__',
  from_equals_reply_to_mismatch: '__from_replyto_mismatch__',
  all_caps_subject_high: '__all_caps_subject_high__',
} as const;

const ALL_CAPS_RATIO_THRESHOLD = 0.5;

export type SpamLabel = 'spam' | 'ham';

export interface SpamVocabularyEntry {
  spam: number;
  ham: number;
}

export interface SpamModelState {
  vocabulary: Record<string, SpamVocabularyEntry>;
  totalSpam: number;
  totalHam: number;
  priorSpam: number;
  priorHam: number;
  trainingRecords: number;
  modelVersion: number;
  lastTrainedAt: string | null;
  decayThresholdDays?: number;
}

export interface SpamClassifyResult {
  verdict: 'spam' | 'ham' | 'uncertain';
  probability: number;
  confidence: number;
  method: 'ml';
}

export interface TokenCounts {
  [word: string]: number;
}

export interface TrainingRecordInput {
  label: string;
  created_at: string | Date;
  token_counts?: TokenCounts | null;
  subject?: string | null;
  body_text?: string | null;
  flag_features?: FlagFeatures | null;
  [key: string]: unknown;
}

export function createEmptyModel(): SpamModelState {
  return {
    vocabulary: {},
    totalSpam: 0,
    totalHam: 0,
    priorSpam: 0.5,
    priorHam: 0.5,
    trainingRecords: 0,
    modelVersion: MODEL_VERSION,
    lastTrainedAt: null,
  };
}

export function flagTokensFor(flagFeatures: FlagFeatures | null | undefined): string[] {
  const tokens: string[] = [];
  if (!flagFeatures) return tokens;
  if (flagFeatures.has_attachment === 1) tokens.push(FLAG_TOKENS.has_attachment);
  if (flagFeatures.attachment_is_executable === 1) {
    tokens.push(FLAG_TOKENS.attachment_is_executable);
  }
  if (flagFeatures.from_equals_reply_to_mismatch === 1) {
    tokens.push(FLAG_TOKENS.from_equals_reply_to_mismatch);
  }
  if ((flagFeatures.all_caps_subject_ratio ?? 0) > ALL_CAPS_RATIO_THRESHOLD) {
    tokens.push(FLAG_TOKENS.all_caps_subject_high);
  }
  return tokens;
}

export function updateIncremental(
  model: SpamModelState,
  tokens: ReadonlyArray<string>,
  flagFeatures: FlagFeatures | null | undefined,
  label: SpamLabel,
): SpamModelState {
  const key = label === 'spam' ? 'spam' : 'ham';
  const next: SpamModelState = {
    ...model,
    vocabulary: { ...model.vocabulary },
    trainingRecords: model.trainingRecords + 1,
    lastTrainedAt: model.lastTrainedAt,
  };

  const allTokens = [...tokens, ...flagTokensFor(flagFeatures)];
  let added = 0;
  for (const token of allTokens) {
    const entry = next.vocabulary[token];
    if (entry) {
      next.vocabulary[token] = { ...entry, [key]: entry[key] + 1 };
    } else {
      next.vocabulary[token] = { spam: 0, ham: 0, [key]: 1 };
    }
    added += 1;
  }

  if (key === 'spam') next.totalSpam = model.totalSpam + added;
  else next.totalHam = model.totalHam + added;

  const sum = next.totalSpam + next.totalHam;
  next.priorSpam = sum === 0 ? 0.5 : next.totalSpam / sum;
  next.priorHam = sum === 0 ? 0.5 : next.totalHam / sum;
  return next;
}

function vocabSize(model: SpamModelState): number {
  return Object.keys(model.vocabulary).length;
}

export function classifyMessage(
  model: SpamModelState | null | undefined,
  tokens: ReadonlyArray<string>,
  flagFeatures: FlagFeatures | null | undefined,
): SpamClassifyResult {
  if (!model || model.trainingRecords === 0) {
    return { verdict: 'uncertain', probability: 0.5, confidence: 0, method: 'ml' };
  }

  const V = vocabSize(model);
  const { totalSpam, totalHam } = model;
  const alpha = ALPHA;

  const logTerm = (count: number, total: number): number =>
    Math.log((count + alpha) / (total + alpha * V));

  let logOdds = Math.log(model.priorSpam) - Math.log(model.priorHam);

  for (const token of tokens) {
    const entry = model.vocabulary[token];
    if (!entry) continue;
    logOdds += logTerm(entry.spam, totalSpam) - logTerm(entry.ham, totalHam);
  }

  for (const method of ['dkim', 'spf', 'dmarc'] as const) {
    const value = flagFeatures?.[`${method}_pass`];
    if (value === null || value === undefined) continue;
    const weight = value === 1 ? AUTH_WEIGHTS[method].pass : AUTH_WEIGHTS[method].fail;
    logOdds += weight;
  }

  const probability = 1 / (1 + Math.exp(-logOdds));
  const confidence = Math.abs(logOdds);
  const verdict = logOdds > 0 ? 'spam' : 'ham';
  return { verdict, probability, confidence, method: 'ml' };
}

export function pruneVocabulary(model: SpamModelState, maxSize = 10000): SpamModelState {
  const totalTokens = model.totalSpam + model.totalHam;
  if (totalTokens === 0) return model;

  const scored: Array<{ word: string; spam: number; ham: number; chi2: number }> = [];
  for (const [word, { spam, ham }] of Object.entries(model.vocabulary)) {
    const count = spam + ham;
    if (count < 3) continue;
    const tf = count / totalTokens;
    if (tf > 0.05) continue;
    scored.push({ word, spam, ham, chi2: chiSquare(spam, ham, model.totalSpam, model.totalHam, totalTokens) });
  }

  scored.sort((a, b) => b.chi2 - a.chi2);
  const kept = scored.slice(0, maxSize);

  const vocabulary: Record<string, SpamVocabularyEntry> = {};
  let totalSpam = 0;
  let totalHam = 0;
  for (const { word, spam, ham } of kept) {
    vocabulary[word] = { spam, ham };
    totalSpam += spam;
    totalHam += ham;
  }

  const sum = totalSpam + totalHam;
  return {
    ...model,
    vocabulary,
    totalSpam,
    totalHam,
    priorSpam: sum === 0 ? 0.5 : totalSpam / sum,
    priorHam: sum === 0 ? 0.5 : totalHam / sum,
  };
}

function chiSquare(a: number, b: number, totalSpam: number, totalHam: number, totalTokens: number): number {
  const c = totalSpam - a;
  const d = totalHam - b;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const col2 = b + d;
  if (row1 === 0 || row2 === 0 || col1 === 0 || col2 === 0) return 0;
  const numerator = totalTokens * (a * d - b * c) ** 2;
  const denominator = row1 * row2 * col1 * col2;
  return denominator === 0 ? 0 : numerator / denominator;
}

export function blendScores(mlScore: number, rulesScore: number, trainingRecords: number): number {
  if (trainingRecords < 50) return rulesScore;
  if (trainingRecords <= 500) return 0.6 * rulesScore + 0.4 * mlScore;
  return 0.2 * rulesScore + 0.8 * mlScore;
}

export function retrainFromRecords(
  records: ReadonlyArray<TrainingRecordInput>,
  decayThresholdDays = 90,
  now: Date | number = new Date(),
): SpamModelState {
  const model = createEmptyModel();
  const nowMs = now instanceof Date ? now.getTime() : now;
  const decayMs = decayThresholdDays * 24 * 60 * 60 * 1000;

  for (const record of records) {
    const label: SpamLabel = record.label === 'spam' ? 'spam' : 'ham';
    const ageMs = Math.max(0, nowMs - new Date(record.created_at).getTime());
    const weight = decayMs > 0 ? 2 ** (-ageMs / decayMs) : 1;

    let tokens: string[] = [];
    if (record.token_counts !== null && record.token_counts !== undefined && typeof record.token_counts === 'object') {
      for (const [word, count] of Object.entries(record.token_counts)) {
        tokens.push(...Array(Math.max(1, Math.round(Number(count)))).fill(word));
      }
    } else {
      tokens = tokenize({ subject: record.subject ?? '', body: record.body_text ?? '' });
    }
    tokens.push(...flagTokensFor(record.flag_features ?? null));

    for (const token of tokens) {
      const entry = model.vocabulary[token] ?? (model.vocabulary[token] = { spam: 0, ham: 0 });
      entry[label] += weight;
    }
    if (label === 'spam') model.totalSpam += weight * tokens.length;
    else model.totalHam += weight * tokens.length;
  }

  const sum = model.totalSpam + model.totalHam;
  model.priorSpam = sum === 0 ? 0.5 : model.totalSpam / sum;
  model.priorHam = sum === 0 ? 0.5 : model.totalHam / sum;
  model.trainingRecords = records.length;
  model.lastTrainedAt = new Date(nowMs).toISOString();
  return model;
}

export function extractTopTokens(
  model: SpamModelState | null | undefined,
  tokens: ReadonlyArray<string>,
  n = 5,
): Array<{ token: string; contribution: number }> {
  if (!model || model.trainingRecords === 0) return [];
  const V = vocabSize(model);
  const alpha = ALPHA;
  const logTerm = (count: number, total: number): number =>
    Math.log((count + alpha) / (total + alpha * V));

  const contributions: Array<{ token: string; contribution: number }> = [];
  for (const token of tokens) {
    const entry = model.vocabulary[token];
    if (!entry) continue;
    const contribution =
      logTerm(entry.spam, model.totalSpam) - logTerm(entry.ham, model.totalHam);
    contributions.push({ token, contribution });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return contributions.slice(0, n);
}
