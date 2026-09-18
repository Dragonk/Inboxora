// Antispam status/admin endpoints.
//
// Namespace /api/spam/*: status, per-user thresholds, decay threshold,
// retrain-now, per-user master enable, GDPR reset, audit trail of deletions
// and the explain payload for the "Why?" modal. Per-account reset lives on
// /api/accounts/:id/spam/reset-training.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { scoreRules } from '../services/spamRules.js';
import { classifyMessage, extractTopTokens } from '../services/spamModel.js';
import { getModelForUser, invalidateModelCache } from '../services/spamModelStore.js';
import { runFullRetrain } from '../services/spamScheduler.js';
import { detectAuthservIds } from '../services/spamAuthservIds.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_THRESHOLDS = {
  minRecords: 50,
  softRecords: 500,
  hardRecords: 500,
  spamThreshold: 0.85,
  autoMoveThreshold: 0.95,
};
const DEFAULT_DECAY_DAYS = 90;

interface UserPreferences {
  spamEnabled?: boolean;
  spam_thresholds?: Record<string, number>;
  [key: string]: unknown;
}

async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const result = await query<{ preferences: UserPreferences | null }>('SELECT preferences FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.preferences ?? {};
}

async function readThresholds(userId: string): Promise<typeof DEFAULT_THRESHOLDS> {
  const prefs = await getUserPreferences(userId);
  const stored = (prefs.spam_thresholds !== null && typeof prefs.spam_thresholds === 'object')
    ? prefs.spam_thresholds
    : {};
  return {
    minRecords: stored.minRecords ?? DEFAULT_THRESHOLDS.minRecords,
    softRecords: stored.softRecords ?? DEFAULT_THRESHOLDS.softRecords,
    hardRecords: stored.hardRecords ?? DEFAULT_THRESHOLDS.hardRecords,
    spamThreshold: stored.spamThreshold ?? DEFAULT_THRESHOLDS.spamThreshold,
    autoMoveThreshold: stored.autoMoveThreshold ?? DEFAULT_THRESHOLDS.autoMoveThreshold,
  };
}

async function writeThresholds(userId: string, patch: Record<string, number>): Promise<void> {
  await query(
    `UPDATE users
     SET preferences = jsonb_set(
       COALESCE(preferences, '{}'::jsonb),
       '{spam_thresholds}',
       (COALESCE(preferences->'spam_thresholds', '{}'::jsonb) || $2::jsonb)
     )
     WHERE id = $1`,
    [userId, JSON.stringify(patch)],
  );
}

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req.session as { userId?: string }).userId ?? '';
    const [model, accounts, prefs] = await Promise.all([
      getModelForUser(userId),
      query<{ n: number }>('SELECT count(*)::int AS n FROM email_accounts WHERE user_id = $1 AND antispam_enabled = true', [userId]),
      getUserPreferences(userId),
    ]);
    const enabled = prefs.spamEnabled !== false && (accounts.rows[0]?.n ?? 0) > 0;
    res.json({
      enabled,
      masterEnabled: prefs.spamEnabled !== false,
      antispamAccounts: accounts.rows[0]?.n ?? 0,
      modelVersion: model?.modelVersion ?? null,
      trainingRecords: model?.trainingRecords ?? 0,
      lastTrainedAt: model?.lastTrainedAt ?? null,
      decayThresholdDays: model?.decayThresholdDays ?? DEFAULT_DECAY_DAYS,
      maturity: (model?.trainingRecords ?? 0) >= 500
        ? 'mature' : (model?.trainingRecords ?? 0) >= 50 ? 'fresh' : 'insufficient',
    });
  } catch (err) { next(err); }
});

router.get('/thresholds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await readThresholds((req.session as { userId?: string }).userId ?? ''));
  } catch (err) { next(err); }
});

router.patch('/thresholds', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { minRecords, softRecords, hardRecords, spamThreshold, autoMoveThreshold } = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, number> = {};
    if (minRecords !== null && minRecords !== undefined) patch.minRecords = Number(minRecords);
    if (softRecords !== null && softRecords !== undefined) patch.softRecords = Number(softRecords);
    if (hardRecords !== null && hardRecords !== undefined) patch.hardRecords = Number(hardRecords);
    if (spamThreshold !== undefined) {
      if (typeof spamThreshold !== 'number' || spamThreshold < 0.5 || spamThreshold > 0.99) {
        return res.status(400).json({ error: 'spamThreshold must be between 0.5 and 0.99' });
      }
      patch.spamThreshold = spamThreshold;
    }
    if (autoMoveThreshold !== undefined) {
      if (typeof autoMoveThreshold !== 'number' || autoMoveThreshold < 0.7 || autoMoveThreshold > 0.99) {
        return res.status(400).json({ error: 'autoMoveThreshold must be between 0.7 and 0.99' });
      }
      patch.autoMoveThreshold = autoMoveThreshold;
    }
    await writeThresholds((req.session as { userId?: string }).userId ?? '', patch);
    res.json(await readThresholds((req.session as { userId?: string }).userId ?? ''));
  } catch (err) { next(err); }
});

router.get('/decay-threshold', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const model = await getModelForUser((req.session as { userId?: string }).userId ?? '');
    res.json({ decayThresholdDays: model?.decayThresholdDays ?? DEFAULT_DECAY_DAYS });
  } catch (err) { next(err); }
});

router.patch('/decay-threshold', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const value = (req.body as { decayThresholdDays?: unknown } | undefined)?.decayThresholdDays;
    const days = parseInt(String(value), 10);
    if (!Number.isInteger(days) || days < 7 || days > 365) {
      return res.status(400).json({ error: 'decayThresholdDays must be an integer between 7 and 365' });
    }
    const userId = (req.session as { userId?: string }).userId ?? '';
    const existing = await getModelForUser(userId);
    await query(
      `INSERT INTO spam_models (user_id, decay_threshold_days)
       VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET decay_threshold_days = $2`,
      [userId, days],
    );
    invalidateModelCache(userId);
    res.json({ decayThresholdDays: days });
    void existing;
  } catch (err) { next(err); }
});

router.post('/retrain-now', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runFullRetrain();
    if (result.accepted === false) {
      return res.status(409).json({ error: 'retrain_in_progress' });
    }
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.post('/enable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled === true;
    await query(
      `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [(req.session as { userId?: string }).userId ?? '', JSON.stringify({ spamEnabled: enabled })],
    );
    res.json({ enabled });
  } catch (err) { next(err); }
});

router.post('/reset-training-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const userId = (req.session as { userId?: string }).userId ?? '';
    const [logRes, modelRes] = await Promise.all([
      query('DELETE FROM spam_training_log WHERE user_id = $1', [userId]),
      query('DELETE FROM spam_models WHERE user_id = $1', [userId]),
    ]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, 'all', $2, $3::inet, $4)`,
      [userId, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);
    const accounts = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM email_accounts WHERE user_id = $1',
      [userId],
    );
    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModels: modelRes.rowCount,
      affectedAccounts: accounts.rows[0]?.n ?? 0,
    });
  } catch (err) { next(err); }
});

router.get('/deletions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT scope, records_deleted, reason, requested_at, account_id
       FROM spam_training_deletions WHERE user_id = $1
       ORDER BY requested_at DESC LIMIT 100`,
      [(req.session as { userId?: string }).userId ?? ''],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

router.get('/authserv-ids', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
    if (!accountId || !UUID_RE.test(accountId)) {
      return res.status(400).json({ error: 'Invalid accountId' });
    }
    const userId = (req.session as { userId?: string }).userId ?? '';
    const owned = await query<{ id: string; trusted_authserv_id: string | null }>(
      'SELECT id, trusted_authserv_id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [accountId, userId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });

    const { analyzed, detected } = await detectAuthservIds(accountId);
    res.json({
      accountId,
      trustedAuthservId: owned.rows[0]?.trusted_authserv_id ?? null,
      analyzed,
      detected,
    });
  } catch (err) { next(err); }
});

router.get('/explain', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : '';
    if (!messageId || !UUID_RE.test(messageId)) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }
    const userId = (req.session as { userId?: string }).userId ?? '';
    const data = await query<{
      subject: string | null; body_text: string | null; body_html: string | null;
      from_email: string | null; attachments: unknown; spam_verdict: string | null;
      spam_score_ml: number | null; spam_details: unknown; owner_id: string;
    }>(
      `SELECT m.*, a.user_id AS owner_id
       FROM messages m JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, userId],
    );
    const row = data.rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });

    // Stored spam_details is the source of truth for "Why?": it captures the
    // exact rules/ML state at decision time (including trusted-auth and
    // contacts context the live recompute below cannot reproduce). Recompute
    // only as a fallback for rows classified before details were persisted.
    const storedDetails = typeof row.spam_details === 'string'
      ? safeParseDetails(row.spam_details)
      : (row.spam_details ?? null);
    if (isStoredSpamDetails(storedDetails)) {
      res.json({
        verdict: row.spam_verdict,
        storedScore: row.spam_score_ml ?? null,
        method: storedDetails.method,
        confidence: storedDetails.mlConfidence ?? storedDetails.rulesScore,
        rulesFired: storedDetails.rulesFired,
        rulesScore: storedDetails.rulesScore,
        mlProbability: storedDetails.mlProbability,
        mlTopTokens: storedDetails.topTokens,
        authservIds: storedDetails.authservIds ?? [],
        trustedAuthservId: storedDetails.trustedAuthservId ?? null,
        authTrusted: storedDetails.authTrusted ?? null,
        storedDetails,
        recomputed: false,
      });
      return;
    }

    const msg = {
      subject: row.subject ?? '',
      body: row.body_text ?? '',
      bodyHtml: row.body_html ?? '',
      from: row.from_email ? `<${row.from_email}>` : null,
      replyTo: null,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      headers: [],
    };
    const tokens = tokenize(msg);
    const flagFeatures = extractFlagFeatures(msg);

    const rules = scoreRules(msg, { userContacts: new Set<string>() });
    const model = await getModelForUser(row.owner_id);
    const trainingRecords = model?.trainingRecords ?? 0;
    const mlActive = trainingRecords >= 50;
    const mlResult = mlActive && model ? classifyMessage(model, tokens, flagFeatures) : null;

    res.json({
      verdict: row.spam_verdict,
      storedScore: row.spam_score_ml ?? null,
      method: mlActive ? 'blended' : 'rules',
      confidence: mlResult?.confidence ?? rules.score,
      rulesFired: rules.fired.map(r => ({ name: r.name, weight: r.weight })),
      rulesScore: rules.score,
      mlProbability: mlResult?.probability ?? null,
      mlTopTokens: extractTopTokens(model, tokens, 5).map(t => ({
        token: t.token, contribution: Math.round(t.contribution * 1000) / 1000,
      })),
      storedDetails: null,
      recomputed: true,
    });
  } catch (err) { next(err); }
});

export const accountSpamRouter = Router();
accountSpamRouter.use(requireAuth);

accountSpamRouter.post('/:id/spam/reset-training', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const { id } = req.params;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid account id' });
    const userId = (req.session as { userId?: string }).userId ?? '';

    const owned = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });

    const logRes = await query(
      'DELETE FROM spam_training_log WHERE user_id = $1 AND account_id = $2',
      [userId, id],
    );
    const modelRes = await query('DELETE FROM spam_models WHERE user_id = $1', [userId]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, account_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, $2, 'per_account', $3, $4::inet, $5)`,
      [userId, id, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);

    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModel: (modelRes.rowCount ?? 0) > 0,
    });
  } catch (err) { next(err); }
});

interface StoredSpamDetails {
  method: string;
  blendedScore: number;
  rulesScore: number;
  rulesFired: Array<{ name: string; weight: number }>;
  mlProbability: number | null;
  mlConfidence?: number | null;
  topTokens: Array<{ token: string; contribution: number }>;
  authservIds?: string[];
  trustedAuthservId?: string | null;
  authTrusted?: boolean | null;
  [key: string]: unknown;
}

function safeParseDetails(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isStoredSpamDetails(value: unknown): value is StoredSpamDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.method === 'string'
    && typeof v.blendedScore === 'number'
    && typeof v.rulesScore === 'number'
    && Array.isArray(v.rulesFired)
    && Array.isArray(v.topTokens);
}

function ipOf(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress;
  if (!ip) return null;
  const plain = ip.replace(/^::ffff:/, '');
  if (plain === '::1' || plain === '127.0.0.1') return '127.0.0.1';
  return ip;
}

function truncateUserAgent(req: Request): string | null {
  const ua = req.headers?.['user-agent'] ?? '';
  return ua.slice(0, 300) || null;
}

export default router;
