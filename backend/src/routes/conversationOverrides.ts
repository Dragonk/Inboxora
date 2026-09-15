import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { applyConversationOverride, listConversationOverrides } from '../services/conversationOverrides.js';
import { uuidParam } from '../utils/uuid.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';

type ConversationOverrideBody = {
  logicalMessageId: string | null;
  scope: string;
  overrideType: string;
  targetId: string | null;
  targetConversationId: string | null;
  reason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  return value;
}

function readConversationOverrideBody(value: unknown): ConversationOverrideBody {
  if (!isRecord(value)) throw new Error('Invalid request body');

  const logicalMessageId = readOptionalString(value.logicalMessageId, 'logicalMessageId');
  const requestedScope = readOptionalString(value.scope, 'scope');
  const overrideType = value.overrideType;
  if (typeof overrideType !== 'string') throw new Error('Unsupported conversation override type');

  return {
    logicalMessageId,
    scope: requestedScope === null ? 'message-only' : requestedScope,
    overrideType,
    targetId: readOptionalString(value.targetId, 'targetId'),
    targetConversationId: readOptionalString(value.targetConversationId, 'targetConversationId'),
    reason: readOptionalString(value.reason, 'reason'),
  };
}

function sessionUserId(req: Request): string {
  const userId = req.session.userId;
  if (typeof userId !== 'string') throw new Error('Not authenticated');
  if (userId.length === 0) throw new Error('Not authenticated');
  return userId;
}

function conversationId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string') throw new Error('Invalid id');
  return id;
}

const router = Router();
router.use(requireAuth);

// Reuse the upstream uuidParam guard so malformed conversation/override IDs return 400.
router.param('id', uuidParam('id'));

router.post('/conversations/:id/overrides', async (req: Request, res: Response) => {
  try {
    const body = readConversationOverrideBody(req.body);
    const result = await applyConversationOverride({
      userId: sessionUserId(req),
      conversationId: conversationId(req),
      logicalMessageId: body.logicalMessageId,
      scope: body.scope,
      overrideType: body.overrideType,
      targetId: body.targetId,
      // P1-03: force-include accepts targetConversationId.
      targetConversationId: body.targetConversationId,
      reason: body.reason,
    });
    res.status(201).json(result);
  } catch (caught) {
    const err = toAppError(caught);
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/conversations/:id/overrides', async (req: Request, res: Response) => {
  res.json({ overrides: await listConversationOverrides({ userId: sessionUserId(req), conversationId: conversationId(req) }) });
});

export default router;
