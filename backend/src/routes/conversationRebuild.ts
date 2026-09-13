import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { getConversationRebuildJob, startConversationRebuildJob, recordConversationRebuildAudit } from '../services/conversationRebuildJobs.js';
import { consumeConversationRebuildRateLimit } from '../services/conversationRebuildRateLimit.js';
import { uuidParam } from '../utils/uuid.js';

const router = Router();
router.use(requireAuth);

// Reuse the upstream uuidParam guard so malformed rebuild job IDs return 400.
router.param('jobId', uuidParam('jobId'));

router.post('/conversations/rebuild', async (req, res) => {
  const userId = req.session.userId;
  await consumeConversationRebuildRateLimit(userId);
  const accountId = req.body?.accountId || null;
  if (accountId) {
    const owned = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });
  }
  const result = startConversationRebuildJob({ userId, accountId, limit: req.body?.limit, dryRun: req.body?.dryRun !== false, force: req.body?.force === true });
  await recordConversationRebuildAudit({ userId, jobId: result.jobId, action: 'requested', details: { accountId, dryRun: req.body?.dryRun !== false, force: req.body?.force === true } });
  res.status(202).json(result);
});

router.get('/conversations/rebuild/:jobId', async (req, res) => {
  const result = getConversationRebuildJob({ userId: req.session.userId, jobId: req.params.jobId });
  if (!result) return res.status(404).json({ error: 'Rebuild job not found' });
  res.json(result);
});

export default router;
