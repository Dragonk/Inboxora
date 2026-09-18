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
}));

import express from 'express';
import spamRoutes from './spam.js';
import { query as __mock_query } from '../services/db.js';
import { getModelForUser as __mock_getModel } from '../services/spamModelStore.js';
import { runFullRetrain as __mock_retrain } from '../services/spamScheduler.js';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);
const getModelForUser = vi.mocked(__mock_getModel);
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
    runFullRetrain.mockReset();
  });

  it('GET /status reports maturity and enable state', async () => {
    getModelForUser.mockResolvedValue({
      vocabulary: {}, totalSpam: 0, totalHam: 0, priorSpam: 0.5, priorHam: 0.5,
      trainingRecords: 120, modelVersion: 1, lastTrainedAt: null, decayThresholdDays: 90,
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

  it('POST /retrain-now surfaces 409 while a run is in flight', async () => {
    runFullRetrain.mockResolvedValue({ accepted: false });
    const res = await fetch(`${base}/api/spam/retrain-now`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'retrain_in_progress' });
  });

  it('PATCH /thresholds rejects out-of-range values', async () => {
    const res = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spamThreshold: 0.2 }),
    });
    expect(res.status).toBe(400);
  });
});
