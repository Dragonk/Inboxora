import { randomUUID } from 'crypto';
import { query } from './db.js';
import { rebuildConversationCopies } from './conversationRebuild.js';

const jobs = new Map();
const MAX_JOBS = 100;
const JOB_TTL_MS = 60 * 60 * 1000;

export function startConversationRebuildJob({ userId, accountId = null, limit = 100, dryRun = true, force = false }) {
  const jobId = randomUUID();
  jobs.set(jobId, { jobId, userId, accountId, force, status: 'queued', createdAt: Date.now(), result: null, error: null });
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  setImmediate(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    try {
      let cursorResult = null;
      let totalScanned = 0;
      let totalUpdated = 0;
      let batches = 0;
      let cursor = null;
      do {
        cursorResult = await rebuildConversationCopies({ userId, accountId, limit, dryRun, cursor, force: force && batches === 0 });
        totalScanned += cursorResult.scanned || 0;
        totalUpdated += cursorResult.updated || 0;
        const totalWouldChange = (job.result?.would_change || 0) + (cursorResult.wouldChange || 0);
        batches += 1;
        cursor = cursorResult.next;
        job.result = { ...cursorResult, scanned: totalScanned, updated: totalUpdated, would_change: totalWouldChange, changed: totalUpdated, batches };
      } while (!cursorResult.complete && job.status !== 'cancelled');
      if (job.status === 'cancelled') return;
      job.status = 'complete';
      await recordConversationRebuildAudit({ userId, jobId, action: 'completed', details: { accountId, dryRun, result: job.result } });
    } catch (error) {
      job.error = error.message;
      job.status = 'failed';
      await recordConversationRebuildAudit({ userId, jobId, action: 'failed', details: { accountId, dryRun, error: error.message } }).catch(() => {});
    }
  });
  return { jobId, status: 'queued' };
}

export function getConversationRebuildJob({ userId, jobId }) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId || Date.now() - job.createdAt > JOB_TTL_MS) return null;
  return { jobId: job.jobId, status: job.status, result: job.result, error: job.error };
}

export async function recordConversationRebuildAudit({ userId, jobId, action, details = {} }) {
  await query('INSERT INTO conversation_rebuild_audit (user_id, job_id, action, details) VALUES ($1,$2,$3,$4::jsonb)', [userId, jobId, action, JSON.stringify(details)]);
}
