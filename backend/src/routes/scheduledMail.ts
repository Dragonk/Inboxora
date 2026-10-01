import { approveAttachmentPreview } from '../services/attachments/scan.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { executeSend } from '../services/sendMail.js';
import { previewScheduledMail, scheduledMailAttachment } from '../services/scheduledMailPreview.js';
import { attachmentDisposition } from '../utils/contentDisposition.js';
import { ScheduledMailError, cancelScheduledMail, dismissScheduledMail, editScheduledMail, enqueueScheduledMail,
  getScheduledSummary, acknowledgeSentMail, enqueueMailMerge, listScheduledMail, pageScheduledMail, rescheduleMail, updateScheduledMail } from '../services/scheduledMail.js';

const router = Router();
// Frozen previews and viewed-status receipts belong to this authenticated session only.
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
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
router.get('/scheduled', handle(req => req.query.page === '1'
  ? pageScheduledMail(req.session.userId!, req.query.cursor) : listScheduledMail(req.session.userId!)));
router.get('/scheduled/:id/summary', handle(req => getScheduledSummary(req.session.userId!, String(req.params.id))));
router.get('/scheduled/:id', handle(req => previewScheduledMail(req.session.userId!, String(req.params.id))));
router.get('/scheduled/:id/attachments/:index', async (req, res) => {
  try {
    const attachment = await scheduledMailAttachment(req.session.userId!, String(req.params.id), req.params.index, req.query.revision);
    if (!await approveAttachmentPreview(req, res, attachment.content)) return;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', attachmentDisposition(attachment.filename));
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(attachment.content);
  } catch (error) {
    if (error instanceof ScheduledMailError) return res.status(error.status).json({ code: error.code, error: error.message });
    throw error;
  }
});
router.post('/scheduled/:id/seen', handle(req => acknowledgeSentMail(req.session.userId!, String(req.params.id))));
router.post('/scheduled', handle(req => enqueueScheduledMail(req.session.userId!, req.body,
  typeof req.headers['x-idempotency-key'] === 'string' ? req.headers['x-idempotency-key'] : '', executeSend)));
router.post('/merge', handle(req => enqueueMailMerge(req.session.userId!, req.body,
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
