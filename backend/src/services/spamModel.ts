// Multinomial Naive Bayes spam classifier — pure logic, no I/O.
//
// Per-user JSONB vocabulary {word: {spam, ham}} with running counts plus
// cached totals and priors, persisted in spam_models. Scoring in
// log-probability space with Laplace smoothing. Auth flags carry fixed
// asymmetric weights (not learned counts); heuristic flags are learned as
// special __tokens__.
//
// Adapted from upstream MailFlow v0.2 for Inboxora (strict TypeScript).

import { createHash } from 'node:crypto';
import { tokenize } from './spamTokenizer.js';
import type { FlagFeatures } from './spamTokenizer.js';

export const MODEL_VERSION = 1;
export const ALPHA = 1.0;

// Canonical training-size bands shared by the pipeline, the HTTP thresholds
// API and the status view. Kept here (pure logic, no I/O) so route modules
// never need to import the pipeline (which pulls db + IMAP-adjacent code).
export const MIN_TRAINING_RECORDS = 50;
export const SOFT_TRAINING_RECORDS = 500;

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
  // Distinct-message maturity: usable unique samples per class. trainingRecords
  // above stays the raw row count (audit-compatible); usableSpam/usableHam
  // gate ML activation so one mail confirmed 50x cannot mature the model.
  // `undefined` = persisted before the usable_* columns existed (pre-upgrade
  // row): isModelMature falls back to the raw count until the next retrain.
  usableSpam?: number;
  usableHam?: number;
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
  message_id_header?: string | null;
  account_id?: string | null;
  message_uid?: number | string | null;
  folder?: string | null;
  training_identity?: string | null;
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
    usableSpam: 0,
    usableHam: 0,
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
  opts: { countUsable?: boolean } = {},
): SpamModelState {
  const key = label === 'spam' ? 'spam' : 'ham';
  // Incremental feedback is one distinct user decision on one message: it
  // counts as one usable sample of its class (unless the state predates the
  // usable_* columns, in which case we leave them undefined so the legacy
  // fallback in isModelMature keeps applying). Repeat feedback on the same
  // message passes countUsable: false so re-confirming one mail cannot mint
  // new distinct samples (the vocabulary below still reinforces normally).
  const countUsable = opts.countUsable ?? true;
  const next: SpamModelState = {
    ...model,
    vocabulary: { ...model.vocabulary },
    trainingRecords: model.trainingRecords + 1,
    usableSpam: model.usableSpam === undefined || !countUsable
      ? model.usableSpam
      : model.usableSpam + (key === 'spam' ? 1 : 0),
    usableHam: model.usableHam === undefined || !countUsable
      ? model.usableHam
      : model.usableHam + (key === 'ham' ? 1 : 0),
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

export function blendScores(
  mlScore: number,
  rulesScore: number,
  trainingRecords: number,
  bands: { minRecords?: number; softRecords?: number } = {},
): number {
  const minRecords = Math.max(1, Math.round(bands.minRecords ?? 50));
  const softRecords = Math.max(minRecords, Math.round(bands.softRecords ?? 500));
  if (trainingRecords < minRecords) return rulesScore;
  if (trainingRecords <= softRecords) return 0.6 * rulesScore + 0.4 * mlScore;
  return 0.2 * rulesScore + 0.8 * mlScore;
}

// ML maturity gate: raw row counts are not enough. The model becomes eligible
// only with at least `minRecords` DISTINCT usable samples AND at least
// `minPerClass` of each class — one mail confirmed 50x, or 50 spams with zero
// hams, must never activate ML (let alone auto-move).
export const MIN_USABLE_PER_CLASS = 10;

export function usableTrainingTotal(model: SpamModelState | null | undefined): number {
  if (!model) return 0;
  return (model.usableSpam ?? 0) + (model.usableHam ?? 0);
}

export function isModelMature(
  model: SpamModelState | null | undefined,
  bands: { minRecords?: number; minPerClass?: number } = {},
): boolean {
  if (!model) return false;
  const minRecords = Math.max(1, Math.round(bands.minRecords ?? 50));
  const minPerClass = Math.max(1, Math.round(bands.minPerClass ?? MIN_USABLE_PER_CLASS));
  // Legacy rows persisted before usableSpam/usableHam existed carry
  // undefined/undefined while trainingRecords > 0: fall back to the raw count
  // so old models do not go dark after upgrade (the next retrain fills in the
  // real split). An explicit 0/0 after a retrain means "no usable samples" —
  // that must NOT mature.
  const usableSplitKnown = model.usableSpam !== undefined || model.usableHam !== undefined;
  if (!usableSplitKnown) return (model.trainingRecords ?? 0) >= minRecords;
  return usableTrainingTotal(model) >= minRecords
    && (model.usableSpam ?? 0) >= minPerClass
    && (model.usableHam ?? 0) >= minPerClass;
}

export function retrainFromRecords(
  records: ReadonlyArray<TrainingRecordInput>,
  decayThresholdDays = 90,
  now: Date | number = new Date(),
): SpamModelState {
  const model = createEmptyModel();
  const nowMs = now instanceof Date ? now.getTime() : now;
  const decayMs = decayThresholdDays * 24 * 60 * 60 * 1000;

  // Latest decision wins per training identity. A user correcting Spam→Ham
  // must actually move the sample: group rows by identity, keep the newest
  // row's label for BOTH maturity and vocabulary. Earlier opposite-label rows
  // for the same identity are dropped entirely (they would otherwise keep
  // teaching the mistake the user just corrected). Callers must feed rows
  // oldest-first (retrainUser orders by created_at, id); the grouping below
  // re-sorts defensively so array order never decides the label.
  const byIdentity = new Map<string, TrainingRecordInput[]>();
  const unidentified: TrainingRecordInput[] = [];
  records.forEach((record, index) => {
    const stored = typeof record.training_identity === 'string' && record.training_identity
      ? record.training_identity
      : messageIdentityFor(record, index);
    if (stored.startsWith('row:')) unidentified.push(record);
    else {
      const group = byIdentity.get(stored);
      if (group) group.push(record);
      else byIdentity.set(stored, [record]);
    }
  });
  const effective: TrainingRecordInput[] = [...unidentified];
  for (const group of byIdentity.values()) {
    group.sort((a, b) => {
      const time = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (time !== 0) return time;
      return String((a as { id?: unknown }).id ?? '').localeCompare(String((b as { id?: unknown }).id ?? ''));
    });
    // Maturity counts the identity once, under its latest label. Vocabulary
    // trains on the latest row only — the corrected label replaces the
    // earlier mistake instead of averaging with it.
    effective.push(group[group.length - 1]);
  }

  // Distinct-message maturity: the same physical mail re-confirmed N times is
  // ONE sample, not N.
  const seenMessages = new Set<string>();
  let usableSpam = 0;
  let usableHam = 0;

  for (let index = 0; index < effective.length; index++) {
    const record = effective[index];
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

    // Legacy 0021 rows (no token_counts, no subject/body) yield zero tokens:
    // they teach the model nothing and must not count toward maturity.
    const usable = tokens.length > 0;
    const identity = typeof record.training_identity === 'string' && record.training_identity
      ? record.training_identity
      : messageIdentityFor(record, index);
    const firstSeen = !seenMessages.has(identity);
    if (firstSeen) seenMessages.add(identity);
    if (usable && firstSeen) {
      if (label === 'spam') usableSpam += 1;
      else usableHam += 1;
    }

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
  model.usableSpam = usableSpam;
  model.usableHam = usableHam;
  model.lastTrainedAt = new Date(nowMs).toISOString();
  return model;
}

function messageIdentityFor(record: TrainingRecordInput, index: number): string {
  const identity = trainingIdentityFor({
    messageIdHeader: typeof record.message_id_header === 'string' ? record.message_id_header : null,
    accountId: typeof record.account_id === 'string' ? record.account_id : null,
    uid: record.message_uid ?? null,
    folder: typeof record.folder === 'string' ? record.folder : null,
    senderDomain: null,
    subject: null,
    bodyText: null,
  });
  return identity ?? `row:${index}`;
}

// Canonical stable training identity shared by the mark-time INSERT
// (mail.ts), the incremental feedback path (spamModelStore) and the full
// retrain grouping below — plus the 0098 backfill and 0099 re-derivation,
// which apply the same rule in SQL. Priority:
//
//   1. Message-ID header — the strongest stable reference.
//   2. Normalized content hash — stable across a MOVE (folder/UID change),
//      which is exactly the case a `copy:` identity cannot survive: mark
//      Spam then Not Spam and the server hands out a new folder+UID for the
//      SAME mail. Content is unchanged by a move.
//   3. Physical copy triple — last resort, only for rows with no header and
//      no content at all (legacy/empty rows).
//
// Pure function over already-loaded values: the caller precomputes this once
// and both the INSERT and every dedup check compare it exactly, so no
// normalization ever happens in SQL at comparison time.
export interface TrainingIdentityInput {
  messageIdHeader?: string | null;
  accountId?: string | null;
  uid?: number | string | null;
  folder?: string | null;
  senderDomain?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}

export function trainingIdentityFor(input: TrainingIdentityInput): string | null {
  const header = (input.messageIdHeader ?? '').trim();
  if (header) return `mid:${header}`;

  const domain = normalizedIdentityPart(input.senderDomain, 255);
  const subject = normalizedIdentityPart(input.subject, 500);
  const bodyLead = normalizedIdentityPart(input.bodyText, 4000);
  if (domain || subject || bodyLead) {
    return `sub:${domain}:${simpleHash(subject)}:${simpleHash(bodyLead)}`;
  }

  const accountId = input.accountId ?? '';
  const folder = input.folder ?? '';
  const uid = input.uid !== null && input.uid !== undefined ? String(input.uid) : '';
  if (accountId && folder && uid) return `copy:${accountId}:${folder}:${uid}`;
  return null;
}

// The single normalization both the TS identity and the SQL backfill use:
// lowercase, collapse runs of whitespace, trim, cap length. Mirroring it in
// SQL (migration 0098/0099) is what makes an already-applied database agree
// with rows written from here.
function normalizedIdentityPart(value: unknown, max: number): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, max);
}

// md5 is a non-security dedup key here (matches the 0098/0099 SQL).
function simpleHash(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
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
