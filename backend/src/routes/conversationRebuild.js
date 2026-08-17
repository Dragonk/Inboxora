import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { rebuildConversationCopies } from '../services/conversationRebuild.js';

const router = Router();
router.use(requireAuth);

router.post('/conversations/rebuild', async (req, res) => {
  const userId = req.session.userId;
  const accountId = req.body?.accountId || null;
  if (accountId) {
    const owned = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });
  }
  const result = await rebuildConversationCopies({
    userId,
    accountId,
    limit: req.body?.limit,
    dryRun: req.body?.dryRun !== false,
  });
  res.json(result);
});

export default router;
