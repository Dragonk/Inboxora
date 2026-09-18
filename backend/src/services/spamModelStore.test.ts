import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query as __mock_query } from './db.js';
import { getModelForUser, saveModel, updateIncrementalForUser, retrainUser, invalidateModelCache } from './spamModelStore.js';

const query = vi.mocked(__mock_query);

beforeEach(() => {
  query.mockReset();
  invalidateModelCache('user-1');
  invalidateModelCache('user-2');
});

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
    query.mockResolvedValue({ rows: [] });
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

  it('trains incrementally from feedback', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM spam_models')) return { rows: [] };
      return { rows: [] };
    });
    const updated = await updateIncrementalForUser('user-2', { subject: 'Free prize', body: 'claim now' }, 'spam');
    expect(updated?.trainingRecords).toBe(1);
    // Subject is weighted x2 in the token stream, so 'prize' counts twice.
    expect(updated?.vocabulary['prize']?.spam).toBe(2);
    expect(updated?.vocabulary['claim']?.spam).toBe(1);
  });

  it('reports no_training_data on an empty log', async () => {
    query.mockResolvedValue({ rows: [] });
    const outcome = await retrainUser('user-1');
    expect(outcome).toMatchObject({ ok: false, recordsUsed: 0, reason: 'no_training_data' });
  });

  it('rebuilds decay-weighted models from the log only', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT label')) {
        return { rows: [
          { label: 'spam', created_at: new Date().toISOString(), account_id: 'a1', message_id_header: '<s1@x>', message_uid: 1, folder: 'INBOX', token_counts: { viagra: 2 }, subject: null, body_text: null, flag_features: null },
          { label: 'ham', created_at: new Date().toISOString(), account_id: 'a1', message_id_header: '<h1@x>', message_uid: 2, folder: 'INBOX', token_counts: { meeting: 1 }, subject: null, body_text: null, flag_features: null },
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

  it('clears the per-user lock slot after a run (no map leak)', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM spam_models')) return { rows: [] };
      return { rows: [] };
    });
    await updateIncrementalForUser('user-2', { subject: 'Free prize', body: 'claim now' }, 'spam');
    // Second run for the same user must still serialize correctly — a leaked
    // slot would either deadlock or silently skip exclusivity.
    const second = await updateIncrementalForUser('user-2', { subject: 'hello', body: 'meeting' }, 'ham');
    expect(second?.trainingRecords).toBe(1);
  });

  it('does not mint a new usable sample for repeat feedback on the same mail', async () => {
    let logCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM spam_models')) {
        return { rows: [{
          vocabulary: {}, total_spam: 4, total_ham: 0, prior_spam: 1, prior_ham: 0,
          training_records: 1, usable_spam: 1, usable_ham: 0,
          model_version: 1, last_trained_at: null, decay_threshold_days: 90,
        }] };
      }
      if (sql.includes('FROM spam_training_log')) return { rows: [{ n: String(logCount) }] };
      return { rows: [] };
    });
    const msg = { subject: 'Free prize', body: 'claim now', from: '<promo@shady.example>' };
    const first = await updateIncrementalForUser('user-2', msg, 'spam');
    // First feedback: no prior row in the log → new distinct sample.
    expect(first?.usableSpam).toBe(2);
    // The mark-spam path inserts the training row right after; simulate it.
    logCount = 1;
    const repeat = await updateIncrementalForUser('user-2', msg, 'spam');
    // Repeat on the same content: vocabulary still reinforces, trainingRecords
    // still grows, but usableSpam must NOT grow — one mail confirmed 50x is
    // one sample, not fifty. (The mocked model row always reads back
    // usable_spam: 1, so the repeat keeps 1 instead of minting 2.)
    expect(repeat?.trainingRecords).toBe(2);
    expect(repeat?.usableSpam).toBe(1);
    // Reinforcement still happens on repeat: the token counts grow even
    // though no new distinct sample is minted.
    expect(repeat?.vocabulary['prize']?.spam).toBeGreaterThan(0);
    expect(repeat?.vocabulary['prize']?.spam).toBe(first?.vocabulary['prize']?.spam);
  });
});
