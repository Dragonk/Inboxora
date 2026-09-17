import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const fakeWorkers = vi.hoisted(() => {
  class FakeWorker {
    readonly posts: Array<Record<string, unknown>> = [];
    terminateCalls = 0;
    private readonly listeners = new Map<string, Listener[]>();

    constructor(..._args: unknown[]) {}

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    unref() {}

    postMessage(message: Record<string, unknown>) {
      this.posts.push(message);
    }

    terminate() {
      this.terminateCalls += 1;
      return Promise.resolve(0);
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) || []) listener(...args);
    }
  }

  return { workers: [] as FakeWorker[], FakeWorker };
});

vi.mock('node:worker_threads', () => ({
  Worker: class extends fakeWorkers.FakeWorker {
    constructor(...args: unknown[]) {
      super(...args);
      fakeWorkers.workers.push(this);
    }
  },
}));

const { closeCalendarProjectionPool, projectCalendarResources } = await import('./calendarProjectionPool.js');

const FROM = new Date('2026-09-01T00:00:00Z');
const TO = new Date('2026-09-02T00:00:00Z');

beforeEach(() => {
  fakeWorkers.workers.length = 0;
  delete process.env.CALENDAR_PROJECTION_DISABLED;
  process.env.CALENDAR_PROJECTION_WORKERS = '1';
});

afterEach(async () => {
  await closeCalendarProjectionPool();
  delete process.env.CALENDAR_PROJECTION_WORKERS;
});

describe('calendar projection worker lifecycle', () => {
  it('never posts a queued healthy job to a worker after its error and before its exit', async () => {
    const projection = projectCalendarResources([{ id: 'broken' }, { id: 'healthy' }], FROM, TO, { cache: false });
    const dyingWorker = fakeWorkers.workers[0];
    expect(dyingWorker.posts).toHaveLength(1);
    expect(dyingWorker.posts[0].row).toMatchObject({ id: 'broken' });

    dyingWorker.emit('error', new Error('worker crashed'));
    // Node emits exit after error. The old slot must already be non-dispatchable,
    // and the exit must not create a second replacement.
    dyingWorker.emit('exit', 1);

    expect(dyingWorker.posts).toHaveLength(1);
    expect(fakeWorkers.workers).toHaveLength(2);
    const replacement = fakeWorkers.workers[1];
    expect(replacement.posts).toHaveLength(1);
    expect(replacement.posts[0].row).toMatchObject({ id: 'healthy' });

    replacement.emit('message', {
      jobId: replacement.posts[0].jobId,
      id: 'healthy',
      events: [{ id: 'healthy', series_id: 'healthy', starts_at: FROM, ends_at: TO }],
      truncated: false,
    });

    const result = await projection;
    expect(result.failures).toContainEqual(expect.objectContaining({ id: 'broken', reason: 'worker-error' }));
    expect(result.failures).not.toContainEqual(expect.objectContaining({ id: 'healthy' }));
    expect(result.events).toContainEqual(expect.objectContaining({ id: 'healthy' }));
  });
});
