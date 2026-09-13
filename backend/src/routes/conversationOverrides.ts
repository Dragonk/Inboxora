import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { applyConversationOverride, listConversationOverrides } from '../services/conversationOverrides.js';
import { uuidParam } from '../utils/uuid.js';

const router = Router();
router.use(requireAuth);

// Reuse the upstream uuidParam guard so malformed conversation/override IDs return 400.
router.param('id', uuidParam('id'));

router.post('/conversations/:id/overrides', async (req, res) => {
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      logicalMessageId: req.body?.logicalMessageId || null,
      scope: req.body?.scope || 'message-only',
      overrideType: req.body?.overrideType,
      targetId: req.body?.targetId || null,
      // P1-03: force-include accepts targetConversationId.
      targetConversationId: req.body?.targetConversationId || null,
      reason: req.body?.reason || null,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/conversations/:id/overrides', async (req, res) => {
  res.json({ overrides: await listConversationOverrides({ userId: req.session.userId, conversationId: req.params.id }) });
});

export default router;
