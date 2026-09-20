import { claimDueSyncHints, completeSyncHint, failSyncHint, type ClaimedSyncHint } from './providerSyncHints.js';
import { runProviderSyncForHint } from './providerSyncScheduler.js';
import { providerPushEnabled, syncHintPollMs } from './providerPushConfig.js';

/**
 * The worker that turns recorded hints into syncs.
 *
 * It runs the **existing** adapters, so a push-accelerated sync and a scheduled one are the same code with
 * the same cursors, leases and reconciliation. Two things make it safe under load and across restarts:
 *
 * - a hint is a row, so a process that dies between "webhook received" and "sync ran" finds the hint still
 *   there and runs it on the next pass;
 * - a claim is exclusive per scope and the row is only deleted when nothing newer arrived, so a
 *   notification landing during a sync is queued rather than lost, and two workers never sync one scope at
 *   the same time.
 *
 * A hint that fails keeps its row and is retried with a widening gap; an installation whose provider is
 * unreachable is never turned into a deletion of the work that is waiting.
 */

let timer: ReturnType<typeof setInterval> | null = null;
let firstPass: ReturnType<typeof setTimeout> | null = null;
let running = false;
let owner = `hints-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export interface SyncHintDrainSummary {
  claimed: number;
  ran: number;
  failed: number;
  deferred: number;
}

/** Under a provider throttle the hint waits longer rather than hammering the provider. */
export function hintRetryDelayMs(error: unknown): number {
  const code = (error as { code?: string } | null)?.code;
  const retryAfter = Number((error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30 * 60_000, retryAfter * 1000);
  if (code === 'RATE_LIMITED') return 5 * 60_000;
  return 60_000;
}

/**
 * A lease already held by another worker is not a failure: the change is being picked up right now, and the
 * hint is released so that run's own completion (or this one's next pass) covers what arrived.
 */
export function isConcurrentSync(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const status = Number((error as { status?: number } | null)?.status);
  const message = error instanceof Error ? error.message : '';
  return status === 409 || code === 'SYNC_IN_FLIGHT' || /already running|another .*sync/i.test(message);
}

export async function runOneSyncHint(hint: ClaimedSyncHint): Promise<'ran' | 'deferred' | 'failed'> {
  try {
    const outcome = await runProviderSyncForHint({
      userId: hint.userId,
      connectionId: hint.connectionId,
      provider: hint.provider,
      resourceType: hint.resourceType,
    });
    if (!outcome.ran) {
      // Not a failure the provider can fix: integrations are off for this installation, or the provider is
      // not configured. Keep the hint short-lived so turning the feature back on picks the work up.
      await failSyncHint({ hintId: hint.id, code: outcome.reason ?? 'SYNC_NOT_RUN', retryDelayMs: 60_000 });
      return 'deferred';
    }
    await completeSyncHint(hint.id);
    return 'ran';
  } catch (error) {
    if (isConcurrentSync(error)) {
      await failSyncHint({ hintId: hint.id, code: 'SYNC_IN_FLIGHT', retryDelayMs: 15_000 });
      return 'deferred';
    }
    await failSyncHint({
      hintId: hint.id,
      code: (error as { code?: string } | null)?.code ?? 'SYNC_FAILED',
      retryDelayMs: hintRetryDelayMs(error),
    });
    console.warn(`Provider sync hint failed for connection ${hint.connectionId} (${hint.provider} ${hint.resourceType}):`, error instanceof Error ? error.message : error);
    return 'failed';
  }
}

export async function drainProviderSyncHints(input: { owner?: string; limit?: number } = {}): Promise<SyncHintDrainSummary> {
  if (!providerPushEnabled()) return { claimed: 0, ran: 0, failed: 0, deferred: 0 };
  const hints = await claimDueSyncHints({ owner: input.owner ?? owner, limit: input.limit ?? 20 });
  const summary: SyncHintDrainSummary = { claimed: hints.length, ran: 0, failed: 0, deferred: 0 };
  for (const hint of hints) {
    const outcome = await runOneSyncHint(hint);
    if (outcome === 'ran') summary.ran += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else summary.deferred += 1;
  }
  return summary;
}

/**
 * Drain in the background, at most one pass at a time.
 *
 * Called right after a webhook (so the latency the feature exists for is real) and on a timer (so a hint
 * recorded just before a restart, or one whose provider was briefly unreachable, is not stranded).
 */
export function triggerProviderSyncHintDrain(): void {
  void drainProviderSyncHints().catch(error => {
    console.warn('Provider sync hint drain failed:', error instanceof Error ? error.message : error);
  });
}

export function startProviderSyncHintWorker(env: NodeJS.ProcessEnv = process.env): void {
  stopProviderSyncHintWorker();
  if (!providerPushEnabled(env)) return;
  owner = `hints-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const pollMs = syncHintPollMs(env);
  firstPass = setTimeout(() => { void tick(); }, 5000);
  if (typeof firstPass.unref === 'function') firstPass.unref();
  timer = setInterval(() => { void tick(); }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainProviderSyncHints({ owner });
  } catch (error) {
    console.warn('Provider sync hint pass failed:', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function stopProviderSyncHintWorker(): void {
  if (firstPass) clearTimeout(firstPass);
  firstPass = null;
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
