import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { applyConversationOverride, listConversationOverrides } from '../services/conversationOverrides.js';

const router = Router();
router.use(requireAuth);

router.post('/conversations/:id/overrides', async (req, res) => {
  const result = await applyConversationOverride({
    userId: req.session.userId,
    conversationId: req.params.id,
    logicalMessageId: req.body?.logicalMessageId || null,
    scope: req.body?.scope || 'message-only',
    overrideType: req.body?.overrideType,
    targetId: req.body?.targetId || null,
    reason: req.body?.reason || null,
  });
  res.status(201).json(result);
});

router.get('/conversations/:id/overrides', async (req, res) => {
  res.json({ overrides: await listConversationOverrides({ userId: req.session.userId, conversationId: req.params.id }) });
});

export default router;
