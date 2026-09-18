import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/spamModelStore.js', () => ({
  getModelForUser: vi.fn(),
  invalidateModelCache: vi.fn(),
  retrainUser: vi.fn(),
}));
vi.mock('../services/spamScheduler.js', () => ({ runFullRetrain: vi.fn() }));
vi.mock('../services/spamAuthservIds.js', () => ({ detectAuthservIds: vi.fn() }));
vi.mock('../services/spamTokenizer.js', () => ({ tokenize: vi.fn(), extractFlagFeatures: vi.fn() }));
vi.mock('../services/spamRules.js', () => ({ scoreRules: vi.fn() }));
vi.mock('../services/spamModel.js', () => ({
  classifyMessage: vi.fn(),
  extractTopTokens: vi.fn(),
  blendScores: vi.fn(),
  isModelMature: vi.fn(),
  usableTrainingTotal: vi.fn(),
  MIN_TRAINING_RECORDS: 50,
  SOFT_TRAINING_RECORDS: 500,
}));

import express from 'express';
import spamRoutes from './spam.js';
import { query as __mock_query } from '../services/db.js';
import { getModelForUser as __mock_getModel, retrainUser as __mock_retrainUser } from '../services/spamModelStore.js';
import { isModelMature as __mock_isMature, usableTrainingTotal as __mock_usableTotal } from '../services/spamModel.js';
import { runFullRetrain as __mock_retrain } from '../services/spamScheduler.js';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);
const getModelForUser = vi.mocked(__mock_getModel);
const retrainUser = vi.mocked(__mock_retrainUser);
const isModelMature = vi.mocked(__mock_isMature);
const usableTrainingTotal = vi.mocked(__mock_usableTotal);
const runFullRetrain = vi.mocked(__mock_retrain);

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/spam', spamRoutes);
  return app;
}

describe('/api/spam routes', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    getModelForUser.mockReset();
    retrainUser.mockReset();
    runFullRetrain.mockReset();
    isModelMature.mockReset();
    usableTrainingTotal.mockReset();
    // Default maturity stubs: individual tests override as needed.
    isModelMature.mockReturnValue(false);
    usableTrainingTotal.mockReturnValue(0);
  });

  it('GET /status reports maturity and enable state', async () => {
    isModelMature.mockReturnValue(true);
    usableTrainingTotal.mockReturnValue(120);
    getModelForUser.mockResolvedValue({
      vocabulary: {}, totalSpam: 0, totalHam: 0, priorSpam: 0.5, priorHam: 0.5,
      trainingRecords: 120, usableSpam: 60, usableHam: 60,
      modelVersion: 1, lastTrainedAt: null, decayThresholdDays: 90,
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM email_accounts WHERE user_id')) return { rows: [{ n: 2 }] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/spam/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, maturity: 'fresh', trainingRecords: 120 });
  });

  it('GET /explain prefers stored spam_details over recompute', async () => {
    const stored = {
      method: 'blended', blendedScore: 0.97, rulesScore: 0.4,
      rulesFired: [{ name: 'AUTH_DKIM_FAIL', weight: 0.4 }],
      mlProbability: 0.98, topTokens: [{ token: 'viagra', contribution: 1.2 }],
      authservIds: ['mx.google.com'], trustedAuthservId: 'mx.google.com', authTrusted: true,
    };
    query.mockImplementation(async () => ({ rows: [{
      subject: 'x', body_text: 'y', body_html: null, from_email: 'a@b.c', attachments: [],
      spam_verdict: 'spam', spam_score_ml: 0.98, spam_details: stored, owner_id: 'user-1',
    }] }));
    const res = await fetch(`${base}/api/spam/explain?messageId=${MESSAGE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.recomputed).toBe(false);
    expect(body.rulesFired).toEqual(stored.rulesFired);
    expect(body.mlTopTokens).toEqual(stored.topTokens);
    expect(getModelForUser).not.toHaveBeenCalled();
  });

  it('POST /retrain-now retrains only the caller (per-user scope)', async () => {
    retrainUser.mockResolvedValue({ ok: true, recordsUsed: 12, duration_ms: 5 });
    const res = await fetch(`${base}/api/spam/retrain-now`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(retrainUser).toHaveBeenCalledWith('user-1');
    expect(runFullRetrain).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, scope: 'user', recordsUsed: 12 });
  });

  it('POST /retrain-now reports 409 with no training data', async () => {
    retrainUser.mockResolvedValue({ ok: false, recordsUsed: 0, duration_ms: 1, reason: 'no_training_data' });
    const res = await fetch(`${base}/api/spam/retrain-now`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_training_data' });
  });

  it('POST /retrain-all surfaces 409 while a run is in flight', async () => {
    runFullRetrain.mockResolvedValue({ accepted: false });
    const res = await fetch(`${base}/api/spam/retrain-all`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'retrain_in_progress' });
  });

  it('PATCH /thresholds rejects out-of-range values', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    const res = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spamThreshold: 0.2 }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /thresholds validates minRecords/softRecords and drops hardRecords', async () => {
    let savedPatch: Record<string, number> = {};
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE users')) {
        try { savedPatch = JSON.parse(String((params as unknown[])[1])); } catch { savedPatch = {}; }
        return { rows: [] };
      }
      if (sql.includes('SELECT preferences FROM users')) {
        return { rows: [{ preferences: { spam_thresholds: { minRecords: 50, softRecords: 500, ...savedPatch } } }] };
      }
      return { rows: [] };
    });
    const bad = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minRecords: 0 }),
    });
    expect(bad.status).toBe(400);
    const badSoft = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ softRecords: -5 }),
    });
    expect(badSoft.status).toBe(400);
    // hardRecords is dead config: accepted-and-ignored would be dishonest, so
    // it is simply not part of the response shape anymore.
    const ok = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hardRecords: 9999, minRecords: 60 }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('hardRecords');
    expect(body.minRecords).toBe(60);
  });

  it('GET /status derives maturity from configured thresholds and usable samples', async () => {
    // 120 raw rows but only one usable spam sample → ML gate closed.
    isModelMature.mockReturnValue(false);
    usableTrainingTotal.mockReturnValue(1);
    getModelForUser.mockResolvedValue({
      vocabulary: {}, totalSpam: 1, totalHam: 0, priorSpam: 1, priorHam: 0,
      trainingRecords: 120, usableSpam: 1, usableHam: 0,
      modelVersion: 1, lastTrainedAt: null, decayThresholdDays: 90,
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM email_accounts WHERE user_id')) return { rows: [{ n: 1 }] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/spam/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maturity).toBe('fresh');
    expect(body.usableTrainingRecords).toBe(1);
  });
});
