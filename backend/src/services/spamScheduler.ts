// Hourly full-retrain scheduler for the antispam classifier.
//
// Retrains only the bucket of users whose staggered offset matches the
// current UTC hour: offset_hours = hash(user_id) % 24. This spreads full
// retrains across 24 hours instead of a 00:00 UTC thundering herd.
//
// Hardening (connection/DB storm review):
//   - one run at a time (single-flight `activeRun` for the whole duration);
//   - the hourly tick is armed only AFTER the current run settles (a
//     self-scheduling timeout, not setInterval), so a slow run delays the
//     next tick instead of overlapping it;
//   - each user gets a bounded slice of the run;
//   - an overlapping run is REFUSED, not queued (admin endpoint surfaces 409).

import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';

export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BOOT_DELAY_MS = 5000;
export const RETRAIN_USER_TIMEOUT_MS = 60 * 1000;

const RUN_TIMEOUT_MARKER = 'retrain_timed_out';

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let activeRun: { kind: 'bucket' | 'full'; promise: Promise<unknown> } | null = null;

export function isRunning(): boolean {
  return activeRun !== null;
}

export function offsetHoursForUser(userId: string): number {
  const hex = String(userId).replace(/-/g, '').slice(0, 8);
  return parseInt(hex, 16) % 24;
}

async function retrainWithTimeout(userId: string): Promise<'ok' | 'timeout' | 'error'> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      retrainUser(userId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(RUN_TIMEOUT_MARKER)), RETRAIN_USER_TIMEOUT_MS);
      }),
    ]);
    return 'ok';
  } catch (caught) {
    const timedOut = caught instanceof Error && caught.message === RUN_TIMEOUT_MARKER;
    console.warn(`spam retrain ${timedOut ? 'timed out' : 'failed'} for ${userId}:`,
      timedOut ? `no result within ${RETRAIN_USER_TIMEOUT_MS}ms` : (caught instanceof Error ? caught.message : String(caught)));
    return timedOut ? 'timeout' : 'error';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface RetrainRunSummary {
  usersProcessed: number;
  usersTimedOut: number;
  totalDuration_ms: number;
}

async function retrainUsers(userIds: string[]): Promise<RetrainRunSummary> {
  const started = Date.now();
  let processed = 0;
  let timedOut = 0;
  for (const userId of userIds) {
    const outcome = await retrainWithTimeout(userId);
    if (outcome === 'ok') processed += 1;
    if (outcome === 'timeout') timedOut += 1;
  }
  return { usersProcessed: processed, usersTimedOut: timedOut, totalDuration_ms: Date.now() - started };
}

function runExclusive<T>(kind: 'bucket' | 'full', fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  activeRun = { kind, promise };
  return promise.finally(() => {
    if (activeRun?.promise === promise) activeRun = null;
  });
}

export async function runBucket(hour: number = new Date().getUTCHours()): Promise<RetrainRunSummary> {
  if (activeRun) {
    return { usersProcessed: 0, usersTimedOut: 0, totalDuration_ms: 0 };
  }
  return runExclusive('bucket', async () => {
    const userIds = await getAllUsersWithTrainingLog();
    const bucket = userIds.filter(id => offsetHoursForUser(id) === hour % 24);
    return retrainUsers(bucket);
  });
}

export async function runFullRetrain(): Promise<{ accepted: boolean; summary?: RetrainRunSummary }> {
  if (activeRun) return { accepted: false };
  const summary = await runExclusive('full', async () => {
    const userIds = await getAllUsersWithTrainingLog();
    return retrainUsers(userIds);
  });
  return { accepted: true, summary };
}

function scheduleNext(): void {
  if (stopped) return;
  timer = setTimeout(async () => {
    try {
      await runBucket();
    } catch (caught) {
      console.warn('spam scheduler bucket failed:', caught instanceof Error ? caught.message : String(caught));
    } finally {
      scheduleNext();
    }
  }, CHECK_INTERVAL_MS);
}

export function start(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(async () => {
    try {
      await runBucket();
    } catch (caught) {
      console.warn('spam scheduler boot bucket failed:', caught instanceof Error ? caught.message : String(caught));
    } finally {
      scheduleNext();
    }
  }, BOOT_DELAY_MS);
}

export function stop(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
