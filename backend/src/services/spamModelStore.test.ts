import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { query as __mock_query, withTransaction as __mock_withTransaction } from './db.js';
import { getModelForUser, saveModel, recordManualFeedback, retrainUser, invalidateModelCache } from './spamModelStore.js';
import type { ManualFeedbackInput } from './spamModelStore.js';
import { MODEL_VERSION } from './spamModel.js';
import type { SpamModelState } from './spamModel.js';

const query = vi.mocked(__mock_query);
const withTransaction = vi.mocked(__mock_withTransaction);

// The store runs its writes inside withTransaction; drive that callback with a
// client whose query() is the same mock, so tests exercise the real sequence.
withTransaction.mockImplementation((async (fn: (client: unknown) => Promise<unknown>) =>
  fn({ query: (text: string, params?: unknown[]) => query(text, params) })) as never);

beforeEach(() => {
  query.mockReset();
  invalidateModelCache('user-1');
  invalidateModelCache('user-2');
});

interface FakeLogRow {
  id: string;
  label: 'spam' | 'ham';
  identity: string | null;
  created_at: string;
  token_counts: Record<string, number>;
}

// Minimal in-memory stand-in for the two tables the store touches. It keeps
// append order so the tests assert real latest-wins behaviour rather than
// just the SQL text.
function installFakeDb() {
  const log: FakeLogRow[] = [];
  let model: SpamModelState | null = null;
  let seq = 0;
  let clock = 0;
  // Fresh, strictly increasing timestamps: retrain applies exponential time
  // decay, so a fixed past date would scale the token counts down and make the
  // assertions about weights rather than about latest-wins.
  const stamp = () => new Date(Date.now() + clock * 1000).toISOString();

  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const p = (params ?? []) as unknown[];
    if (sql.startsWith('SELECT label FROM spam_training_log')) {
      const identity = String(p[1]);
      const matches = log.filter(r => r.identity === identity);
      return { rows: matches.length ? [{ label: matches[matches.length - 1].label }] : [] };
    }
    if (sql.includes('INSERT INTO spam_training_log')) {
      clock += 1;
      log.push({
        id: String(seq++).padStart(4, '0'),
        label: p[5] as 'spam' | 'ham',
        identity: (p[13] as string | null) ?? null,
        created_at: stamp(),
        token_counts: JSON.parse(String(p[9] ?? '{}')) as Record<string, number>,
      });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM spam_models')) {
      return { rows: model ? [toRow(model)] : [] };
    }
    if (sql.includes('INSERT INTO spam_models')) {
      model = fromParams(p);
      return { rows: [] };
    }
    if (sql.includes('FROM spam_training_log')) {
      return {
        rows: log.map(r => ({
          id: r.id, label: r.label, created_at: r.created_at, account_id: 'acct-1',
          message_id_header: null, message_uid: null, folder: null,
          training_identity: r.identity, token_counts: r.token_counts,
          subject: null, body_text: null, flag_features: null,
        })),
      };
    }
    return { rows: [] };
  });

  return { log, getModel: () => model };
}

function toRow(model: SpamModelState): Record<string, unknown> {
  return {
    vocabulary: model.vocabulary,
    total_spam: model.totalSpam, total_ham: model.totalHam,
    prior_spam: model.priorSpam, prior_ham: model.priorHam,
    training_records: model.trainingRecords,
    usable_spam: model.usableSpam ?? 0, usable_ham: model.usableHam ?? 0,
    model_version: model.modelVersion ?? MODEL_VERSION,
    last_trained_at: model.lastTrainedAt, decay_threshold_days: model.decayThresholdDays ?? 90,
  };
}

function fromParams(p: unknown[]): SpamModelState {
  return {
    vocabulary: (typeof p[1] === 'string' ? JSON.parse(p[1]) : {}) as SpamModelState['vocabulary'],
    totalSpam: Number(p[2]), totalHam: Number(p[3]),
    priorSpam: Number(p[4]), priorHam: Number(p[5]),
    trainingRecords: Number(p[6]),
    usableSpam: Number(p[7]), usableHam: Number(p[8]),
    decayThresholdDays: Number(p[9]),
    modelVersion: Number(p[10]),
    lastTrainedAt: String(p[11]),
  };
}

function feedback(overrides: Partial<ManualFeedbackInput> = {}): ManualFeedbackInput {
  return {
    userId: 'user-2', accountId: 'acct-1', messageIdHeader: '<m1@mail.example>',
    messageUid: 42, folder: 'INBOX', label: 'spam',
    subject: 'viagra', bodyText: 'buy now', bodyHtml: null,
    tokenCounts: { viagra: 1 },
    flagFeatures: {
      dkim_pass: null, spf_pass: null, dmarc_pass: null, has_attachment: 0,
      attachment_is_executable: 0, all_caps_subject_ratio: 0, from_equals_reply_to_mismatch: 0,
    },
    senderDomain: 'mail.example', attachmentTypes: null,
    trainMessage: { subject: 'viagra', body: 'buy now', from: '<promo@mail.example>' },
    ...overrides,
  };
}

describe('spam model store', () => {
  it('returns null on cold start and caches the miss', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getModelForUser('user-1')).toBeNull();
    expect(await getModelForUser('user-1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('upserts and invalidates the cache on save', async () => {
    query.mockResolvedValue({ rows: [] });
    await getModelForUser('user-1');
    expect(query).toHaveBeenCalledTimes(1);
    await saveModel('user-1', {
      vocabulary: { viagra: { spam: 2, ham: 0 } },
      totalSpam: 2, totalHam: 0, priorSpam: 1, priorHam: 0,
      trainingRecords: 1, usableSpam: 1, usableHam: 0, modelVersion: 1, lastTrainedAt: null,
    });
    const upsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO spam_models'));
    expect(upsert).toBeTruthy();
    query.mockResolvedValueOnce({ rows: [{
      vocabulary: { viagra: { spam: 2, ham: 0 } },
      total_spam: 2, total_ham: 0, prior_spam: 1, prior_ham: 0,
      training_records: 1, model_version: 1, last_trained_at: null, decay_threshold_days: 90,
    }] });
    const model = await getModelForUser('user-1');
    expect(model?.trainingRecords).toBe(1);
  });

  it('reports no_training_data on an empty log', async () => {
    query.mockResolvedValue({ rows: [] });
    const outcome = await retrainUser('user-1');
    expect(outcome).toMatchObject({ ok: false, recordsUsed: 0, reason: 'no_training_data' });
  });

  it('rebuilds decay-weighted models from the log only', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM spam_training_log')) {
        return { rows: [
          { id: 'a', label: 'spam', created_at: new Date().toISOString(), account_id: 'a1', message_id_header: '<s1@x>', message_uid: 1, folder: 'INBOX', training_identity: 'mid:<s1@x>', token_counts: { viagra: 2 }, subject: null, body_text: null, flag_features: null },
          { id: 'b', label: 'ham', created_at: new Date().toISOString(), account_id: 'a1', message_id_header: '<h1@x>', message_uid: 2, folder: 'INBOX', training_identity: 'mid:<h1@x>', token_counts: { meeting: 1 }, subject: null, body_text: null, flag_features: null },
        ] };
      }
      if (sql.startsWith('SELECT * FROM spam_models')) return { rows: [] };
      return { rows: [] };
    });
    const outcome = await retrainUser('user-1');
    expect(outcome.ok).toBe(true);
    expect(outcome.recordsUsed).toBe(2);
    const saved = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO spam_models'));
    expect(saved?.[1]?.[1]).toContain('viagra');
  });

  it('trains incrementally for a first-time identity', async () => {
    installFakeDb();
    const updated = await recordManualFeedback(feedback());
    expect(updated?.usableSpam).toBe(1);
    expect(updated?.usableHam).toBe(0);
    expect(updated?.trainingRecords).toBe(1);
    expect(updated?.vocabulary['viagra']?.spam).toBeGreaterThan(0);
  });

  it('runs the training row and the model write in one transaction', async () => {
    installFakeDb();
    withTransaction.mockClear();
    await recordManualFeedback(feedback());
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('logs a repeat confirmation without touching vocabulary or usable counters', async () => {
    const db = installFakeDb();
    const first = await recordManualFeedback(feedback());
    expect(first?.usableSpam).toBe(1);
    const spamTokensAfterFirst = first?.vocabulary['viagra']?.spam ?? 0;

    const repeat = await recordManualFeedback(feedback());
    // Both decisions are logged (audit + raw counter) ...
    expect(db.log).toHaveLength(2);
    expect(repeat?.trainingRecords).toBe(2);
    // ... but 100 "Spam" clicks on one mail must not outweigh the model.
    expect(repeat?.usableSpam).toBe(1);
    expect(repeat?.vocabulary['viagra']?.spam).toBe(spamTokensAfterFirst);
  });

  it('rebuilds with latest-wins when the label flips Spam -> Ham', async () => {
    const db = installFakeDb();
    const first = await recordManualFeedback(feedback());
    expect(first?.usableSpam).toBe(1);
    expect(first?.usableHam).toBe(0);

    const corrected = await recordManualFeedback(feedback({ label: 'ham' }));
    // The sample moved to the new label instead of being counted twice, and
    // the earlier wrong-label training was dropped from the vocabulary.
    expect(db.log).toHaveLength(2);
    expect(corrected?.usableSpam).toBe(0);
    expect(corrected?.usableHam).toBe(1);
    // Only the latest (ham) row trains: the earlier spam row is gone from the
    // vocabulary, and the surviving weight is the decay-scaled ham count (~1).
    expect(corrected?.vocabulary['viagra']?.spam).toBe(0);
    expect(corrected?.vocabulary['viagra']?.ham).toBeCloseTo(1, 2);
  });

  it('clears the per-user lock slot after a run (no map leak)', async () => {
    installFakeDb();
    await recordManualFeedback(feedback());
    // A second run for the same user must still serialize correctly — a leaked
    // slot would either deadlock or silently skip exclusivity.
    const second = await recordManualFeedback(feedback({ messageIdHeader: '<m2@mail.example>' }));
    expect(second?.usableSpam).toBe(2);
  });
});
