import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRow, SendExecutor } from './scheduledMail.js';
import type { SendExecutionResult } from './sendMail.js';

const queue = vi.hoisted(() => ({
  claimScheduledMail: vi.fn(), completeScheduledMail: vi.fn(), recoverScheduledMail: vi.fn(),
  renewScheduledClaim: vi.fn(), beginScheduledDispatch: vi.fn(), releaseScheduledClaim: vi.fn(),
}));
vi.mock('./scheduledMail.js', () => queue);
vi.mock('./sendMail.js', () => ({ executeSend: vi.fn() }));
import { createScheduledMailWorker } from './scheduledMailWorker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function row(): ScheduledRow {
  const accountId = randomUUID();
  return {
    id: randomUUID(), accountId, user_id: randomUUID(), subject: 'Frozen message',
    mode: 'schedule', state: 'preparing', scheduledAt: new Date('2026-09-28T10:00:00Z'),
    timeZone: 'Europe/Prague', revision: 3, errorCode: null, lease_token: randomUUID(),
    request_fingerprint: 'original-request', edit_fingerprint: null,
    payload: { senderEmail: 'sender@example.test', payload: {
      accountId, to: ['to@example.test'], bcc: ['private@example.test'],
      body: 'Prepared content', bodyIsHtml: false, editedSignature: 'Frozen signature',
    } },
  };
}
const sent: SendExecutionResult = { status: 200, body: { success: true } };
// Exact internal result emitted by executeSend after a proven pre-dispatch refusal.
const prevented: SendExecutionResult = { status: 409, dispatchPrevented: true, body: { code: 'SEND_DISPATCH_PREVENTED' } };

describe('scheduled mail worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    queue.recoverScheduledMail.mockResolvedValue(undefined);
    queue.claimScheduledMail.mockResolvedValue(null);
    queue.completeScheduledMail.mockResolvedValue(undefined);
    queue.releaseScheduledClaim.mockResolvedValue(undefined);
    queue.beginScheduledDispatch.mockResolvedValue(true);
    queue.renewScheduledClaim.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('creates no work until tick, bounds each batch to four, and preserves the durable send identity', async () => {
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValue(claimed);
    const provider = vi.fn().mockResolvedValue(sent);
    const execute = vi.fn<SendExecutor>(async (_user, _payload, _key, options) =>
      await options?.beforeDispatch?.() ? provider() : prevented);
    const worker = createScheduledMailWorker(execute);
    expect(queue.claimScheduledMail).not.toHaveBeenCalled();
    await worker.tick();
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(1);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(4);
    expect(provider).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenCalledWith(claimed.user_id, claimed.payload.payload,
      `scheduled:${claimed.id}:3`, expect.objectContaining({ expectedSenderEmail: claimed.payload.senderEmail }));
    expect(queue.beginScheduledDispatch).toHaveBeenCalledWith(claimed);
    expect(queue.completeScheduledMail).toHaveBeenCalledTimes(4);
    expect(queue.completeScheduledMail).toHaveBeenLastCalledWith(claimed, sent);
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it.each(['SEND_DISPATCH_PREVENTED', 'SEND_OUTCOME_UNKNOWN'])('does not release on provider code %s without internal proof', async code => {
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    const response: SendExecutionResult = { status: 503, body: { code, dispatchPrevented: true } };
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      expect(await options?.beforeDispatch?.()).toBe(true);
      return response;
    });
    await worker.tick();
    expect(queue.releaseScheduledClaim).not.toHaveBeenCalled();
    expect(queue.completeScheduledMail).toHaveBeenCalledExactlyOnceWith(claimed, response);
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it('leaves a proven unsent claim for recovery when release fails without completing it as failed', async () => {
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    queue.releaseScheduledClaim.mockRejectedValueOnce(new Error('Release database unavailable'));
    const worker = createScheduledMailWorker(async () => prevented);
    await worker.tick();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledExactlyOnceWith(claimed);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Scheduled claim release failed:', 'Release database unavailable');
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it('shares an active tick and never overlaps deliveries', async () => {
    const preparation = deferred<SendExecutionResult>();
    queue.claimScheduledMail.mockResolvedValueOnce(row()).mockResolvedValueOnce(row());
    const execute = vi.fn<SendExecutor>().mockReturnValueOnce(preparation.promise).mockResolvedValue(sent);
    const worker = createScheduledMailWorker(execute);
    const first = worker.tick();
    expect(worker.tick()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(1);
    preparation.resolve(sent);
    await first;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('does not dispatch after stop while preparation is pending and waits for completion', async () => {
    const ready = deferred<void>();
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    const provider = vi.fn();
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      await ready.promise;
      if (!await options?.beforeDispatch?.()) return prevented;
      provider();
      return sent;
    });
    const running = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    ready.resolve();
    await Promise.all([running, stopping]);
    expect(provider).not.toHaveBeenCalled();
    expect(queue.beginScheduledDispatch).not.toHaveBeenCalled();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledExactlyOnceWith(claimed);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    await worker.tick();
    worker.start();
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['expired lease', 'renewal error'])('blocks provider submission after %s', async failure => {
    const ready = deferred<void>();
    queue.claimScheduledMail.mockResolvedValueOnce(row());
    if (failure === 'expired lease') queue.renewScheduledClaim.mockResolvedValue(false);
    else queue.renewScheduledClaim.mockRejectedValue(new Error('Database disconnected'));
    const provider = vi.fn();
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      await ready.promise;
      if (!await options?.beforeDispatch?.()) return prevented;
      provider();
      return sent;
    });
    const running = worker.tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.renewScheduledClaim).toHaveBeenCalledTimes(1);
    ready.resolve();
    await running;
    expect(queue.beginScheduledDispatch).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledTimes(1);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it('honors the atomic dispatch gate when ownership was lost after preparation', async () => {
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    queue.beginScheduledDispatch.mockResolvedValue(false);
    const provider = vi.fn();
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      if (!await options?.beforeDispatch?.()) return prevented;
      provider();
      return sent;
    });
    await worker.tick();
    expect(queue.beginScheduledDispatch).toHaveBeenCalledExactlyOnceWith(claimed);
    expect(provider).not.toHaveBeenCalled();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledExactlyOnceWith(claimed);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('does not submit when stopped while the database dispatch gate is pending', async () => {
    const dispatchGate = deferred<boolean>();
    queue.claimScheduledMail.mockResolvedValueOnce(row());
    queue.beginScheduledDispatch.mockReturnValueOnce(dispatchGate.promise);
    const provider = vi.fn();
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      if (!await options?.beforeDispatch?.()) return prevented;
      provider();
      return sent;
    });
    const running = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.beginScheduledDispatch).toHaveBeenCalledTimes(1);
    const stopping = worker.stop();
    dispatchGate.resolve(true);
    await Promise.all([running, stopping]);
    expect(provider).not.toHaveBeenCalled();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledTimes(1);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not submit when heartbeat loses ownership during the pending dispatch gate', async () => {
    const dispatchGate = deferred<boolean>();
    queue.claimScheduledMail.mockResolvedValueOnce(row());
    queue.beginScheduledDispatch.mockReturnValueOnce(dispatchGate.promise);
    queue.renewScheduledClaim.mockResolvedValue(false);
    const provider = vi.fn();
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      if (!await options?.beforeDispatch?.()) return prevented;
      provider();
      return sent;
    });
    const running = worker.tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queue.beginScheduledDispatch).toHaveBeenCalledTimes(1);
    expect(queue.renewScheduledClaim).toHaveBeenCalledTimes(1);
    dispatchGate.resolve(true);
    await running;
    expect(provider).not.toHaveBeenCalled();
    expect(queue.releaseScheduledClaim).toHaveBeenCalledTimes(1);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it.each([false, true])('classifies interruption according to dispatch boundary (dispatched=%s)', async dispatched => {
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    const provider = vi.fn().mockRejectedValue(new Error('Connection interrupted'));
    const worker = createScheduledMailWorker(async (_user, _payload, _key, options) => {
      if (!dispatched) throw new Error('Attachment unavailable');
      expect(await options?.beforeDispatch?.()).toBe(true);
      return provider();
    });
    await worker.tick();
    expect(provider).toHaveBeenCalledTimes(dispatched ? 1 : 0);
    expect(queue.completeScheduledMail).toHaveBeenCalledExactlyOnceWith(claimed, {
      status: 503, body: { code: dispatched ? 'SEND_OUTCOME_UNKNOWN' : 'SCHEDULE_PREPARATION_FAILED' },
    });
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it('does not overlap slow heartbeat renewals and clears heartbeat after delivery', async () => {
    const renewal = deferred<boolean>();
    const submission = deferred<SendExecutionResult>();
    const claimed = row();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    queue.renewScheduledClaim.mockReturnValue(renewal.promise);
    const worker = createScheduledMailWorker(() => submission.promise);
    const running = worker.tick();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(queue.renewScheduledClaim).toHaveBeenCalledExactlyOnceWith(claimed);
    renewal.resolve(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queue.renewScheduledClaim).toHaveBeenCalledTimes(2);
    submission.resolve(sent);
    await running;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(queue.renewScheduledClaim).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await worker.stop();
  });

  it('finishes recovery before claiming and never invokes provider for observed completed work', async () => {
    const recovery = deferred<void>();
    queue.recoverScheduledMail.mockReturnValueOnce(recovery.promise);
    const execute = vi.fn<SendExecutor>();
    const worker = createScheduledMailWorker(execute);
    const running = worker.tick();
    await Promise.resolve();
    expect(queue.claimScheduledMail).not.toHaveBeenCalled();
    recovery.resolve();
    await running;
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(queue.beginScheduledDispatch).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('polls due work each second, bounds recovery scans to 30 seconds, and stops all future work', async () => {
    const worker = createScheduledMailWorker(vi.fn<SendExecutor>());
    worker.start();
    worker.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(1);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(2);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(31);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(2);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(31);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not claim after recovery fails and permits a later tick to recover', async () => {
    queue.recoverScheduledMail.mockRejectedValueOnce(new Error('Recovery database unavailable'));
    const execute = vi.fn<SendExecutor>();
    const worker = createScheduledMailWorker(execute);
    await expect(worker.tick()).rejects.toThrow('Recovery database unavailable');
    expect(queue.claimScheduledMail).not.toHaveBeenCalled();
    await worker.tick();
    expect(queue.recoverScheduledMail).toHaveBeenCalledTimes(2);
    expect(queue.claimScheduledMail).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await worker.stop();
  });
});
