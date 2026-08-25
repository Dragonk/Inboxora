// Sanitized diagnostics report endpoint. Returns only the server-owned, vetted,
// non-identifying sections of the report (see services/diagnosticsReport.js),
// scoped strictly to the authenticated user. The frontend adds environment/meta
// and drives the preview + download; nothing is sent anywhere automatically.

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { buildServerReport, scrubReport } from '../services/diagnosticsReport.js';

const router = express.Router();
router.use(requireAuth);

router.post('/report', async (req, res) => {
  const salt = typeof req.body?.salt === 'string' ? req.body.salt : '';
  if (!/^[0-9a-f]{16,64}$/i.test(salt)) {
    return res.status(400).json({ error: 'salt must be 16-64 hex characters' });
  }
  const report = await buildServerReport(req.session.userId, salt);
  const { scrubbed, counters } = scrubReport(report);
  res.json({ ...scrubbed, scrub: counters });
});

export default router;
