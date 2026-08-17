import { randomUUID } from 'crypto';
import { query } from './db.js';
import { rebuildConversationCopies } from './conversationRebuild.js';

const jobs = new Map();
const MAX_JOBS = 100;
const JOB_TTL_MS = 60 * 60 * 1000;

export function startConversationRebuildJob({ userId, accountId = null, limit = 100, dryRun = true }) {
  const jobId = randomUUID();
  jobs.set(jobId, { jobId, userId, accountId, status: 'queued', createdAt: Date.now(), result: null, error: null });
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  setImmediate(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    try {
      job.result = await rebuildConversationCopies({ userId, accountId, limit, dryRun });
      job.status = 'complete';
    } catch (error) {
      job.error = error.message;
      job.status = 'failed';
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
