import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { effectiveSendLimits } from '../services/sendLimits.js';
import { transportKindForAccount } from '../services/sendTransport.js';
import { executeSend } from '../services/sendMail.js';
export { ensureServerAutoSavedSentCopy, type SentCopyManager } from '../services/sendMail.js';
export { mailMaxMessageBytes } from '../services/sendLimits.js';

const router = Router();
router.use(requireAuth);

router.get('/send-limits', async (req, res) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  const result = await query<{ id: string; mail_transport: string | null }>(
    'SELECT id, mail_transport FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

  const transport = transportKindForAccount(result.rows[0]);
  const limits = effectiveSendLimits(transport);
  const orNull = (value: number) => (Number.isFinite(value) ? value : null);
  res.json({
    transport,
    limits: {
      singleAttachmentBytes: orNull(limits.singleAttachmentBytes),
      totalAttachmentBytes: orNull(limits.totalAttachmentBytes),
      inlineImageBytes: orNull(limits.inlineImageBytes),
      composedMessageBytes: orNull(limits.composedMessageBytes),
      providerRawMessageBytes: orNull(limits.providerRawMessageBytes),
      providerUploadFileBytes: orNull(limits.providerUploadFileBytes),
      uploadSessionThresholdBytes: orNull(limits.uploadSessionThresholdBytes),
      httpRequestBodyBytes: orNull(limits.httpRequestBodyBytes),
    },
  });
});

router.post('/send', async (req, res) => {
  const key = typeof req.headers['x-idempotency-key'] === 'string'
    ? req.headers['x-idempotency-key'].slice(0, 128) : null;
  // Worker receipts use a reserved namespace. A client must not manufacture a
  // same-user receipt that recovery could attribute to a queued delivery after
  // its original, definitely-unsent intent has been released.
  if (key?.startsWith('scheduled:')) {
    return res.status(400).json({ code: 'SEND_RESERVED_KEY', error: 'This idempotency key is reserved for scheduled delivery.' });
  }
  const result = await executeSend(req.session.userId!, req.body, key);
  return res.status(result.status).json(result.body);
});

export default router;
