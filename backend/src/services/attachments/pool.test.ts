import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('node:worker_threads', () => ({ Worker: class { constructor() { return createWorker(); } } }));
import { runAttachmentWorker } from './pool.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('worker failures retain their public error category', () => {
  it.each([['ERR_WORKER_OUT_OF_MEMORY', 'LIMIT'], ['OTHER', 'CORRUPT']])('%s returns %s without private diagnostics', async (code, expected) => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 1) });
    createWorker.mockReturnValue(worker);
    const operation = runAttachmentWorker({ action: 'probe', bytes: new Uint8Array([1]) }, new AbortController().signal);
    const assertion = expect(operation).rejects.toMatchObject({ code: expected, message: expected });
    worker.emit('error', Object.assign(new Error('private document details'), { code }));
    worker.emit('exit', 1);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('terminates timed-out parsing and returns LIMIT', async () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 1) });
    createWorker.mockReturnValue(worker);
    const operation = runAttachmentWorker({ action: 'probe', bytes: new Uint8Array([1]) }, new AbortController().signal);
    const assertion = expect(operation).rejects.toMatchObject({ code: 'LIMIT' });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
