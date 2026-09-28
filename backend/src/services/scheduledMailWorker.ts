import { executeSend } from './sendMail.js';
import { beginScheduledDispatch, claimScheduledMail, completeScheduledMail, recoverScheduledMail,
  renewScheduledClaim, type ScheduledRow, type SendExecutor } from './scheduledMail.js';

/** Queue runner. Creating this object does not start it or send a message. */
export function createScheduledMailWorker(execute: SendExecutor = executeSend) {
  let stopped = false;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRecoveryAt = 0;
  async function deliver(row: ScheduledRow): Promise<void> {
    let ownsLease = true;
    let dispatched = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || !ownsLease) return;
      renewing = true;
      void renewScheduledClaim(row).then(owned => { ownsLease = owned; }).catch(error => {
        ownsLease = false;
        console.error('Scheduled send lease renewal failed:', error instanceof Error ? error.message : 'database error');
      }).finally(() => { renewing = false; });
    }, 30_000);
    heartbeat.unref();
    try {
      const response = await execute(row.user_id, row.payload.payload, `scheduled:${row.id}:${row.revision}`, {
        expectedSenderEmail: row.payload.senderEmail,
        beforeDispatch: async () => {
          if (stopped || !ownsLease) return false;
          dispatched = await beginScheduledDispatch(row);
          // Shutdown or a renewal failure can occur while the database gate
          // is in flight. Recheck both after its acknowledgement, before handing
          // the message to the shared send pipeline.
          return dispatched && !stopped && ownsLease;
        },
      });
      await completeScheduledMail(row, response);
    } catch (error) {
      console.error('Scheduled send failed:', error instanceof Error ? error.message : 'unknown failure');
      await completeScheduledMail(row, { status: 503, body: {
        code: dispatched ? 'SEND_OUTCOME_UNKNOWN' : 'SCHEDULE_PREPARATION_FAILED',
      } });
    } finally { clearInterval(heartbeat); }
  }
  async function batch(): Promise<void> {
    // Due work stays responsive without scanning durable receipt history every
    // second. Recovery retries promptly on error and otherwise runs every 30s.
    if (Date.now() >= nextRecoveryAt) {
      await recoverScheduledMail();
      nextRecoveryAt = Date.now() + 30_000;
    }
    for (let i = 0; i < 4 && !stopped; i++) {
      const row = await claimScheduledMail();
      if (!row) break;
      await deliver(row);
    }
  }
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (!active) active = batch().finally(() => { active = null; });
    return active;
  }
  function start(): void {
    if (timer || stopped) return;
    const loop = () => {
      timer = null;
      void tick().catch(error => console.error('Scheduled mail worker failed:', error instanceof Error ? error.message : 'database error'))
        .finally(() => { if (!stopped) { timer = setTimeout(loop, 1000); timer.unref(); } });
    };
    timer = setTimeout(loop, 0);
    timer.unref();
  }
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await active;
  }
  return { tick, start, stop };
}
