import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { executeSend } from '../services/sendMail.js';
import { ScheduledMailError, cancelScheduledMail, dismissScheduledMail, editScheduledMail, enqueueScheduledMail,
  listScheduledMail, rescheduleMail, updateScheduledMail } from '../services/scheduledMail.js';

const router = Router();
router.use(requireAuth);
/** Keep every operation scoped to the authenticated owner. */
function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { return res.json(await action(req)); }
    catch (error) {
      if (error instanceof ScheduledMailError) return res.status(error.status).json({ code: error.code, error: error.message });
      throw error;
    }
  };
}
router.get('/scheduled', handle(req => listScheduledMail(req.session.userId!)));
router.post('/scheduled', handle(req => enqueueScheduledMail(req.session.userId!, req.body,
  typeof req.headers['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : '', executeSend)));
router.post('/scheduled/:id/edit', handle(async req => {
  const row = await editScheduledMail(req.session.userId!, String(req.params.id), req.body?.revision);
  return { id: row.id, revision: row.revision, state: row.state, scheduledAt: row.scheduledAt,
    timeZone: row.timeZone, message: row.payload.payload };
}));
router.put('/scheduled/:id', handle(req => updateScheduledMail(req.session.userId!, String(req.params.id), req.body, executeSend)));
router.patch('/scheduled/:id', handle(req => rescheduleMail(req.session.userId!, String(req.params.id), req.body)));
router.post('/scheduled/:id/dismiss', handle(req => dismissScheduledMail(req.session.userId!, String(req.params.id), req.body?.revision)));
router.post('/scheduled/:id/cancel', handle(req => cancelScheduledMail(req.session.userId!, String(req.params.id), req.body?.revision)));
export default router;
