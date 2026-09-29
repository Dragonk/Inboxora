import { api } from './api.ts';
import { getAuthEpoch } from './authEpoch.ts';

type Sender = (ids: string[], read: boolean, accounts: string[]) => Promise<unknown>;
interface Item { id: string; account: string; read: boolean; epoch: number; resolve(value: unknown): void; reject(error: unknown): void }

/** The physical intent queues retain ordering/settlement. This layer only joins
 * ready writes, preserving each item's response and never crossing sessions. */
export function createMailReadBatch(send: Sender, epoch: () => number, batchSize = 500, concurrency = 4) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid mail batching limits');
  let waiting: Item[] = [];
  let active = 0;
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    const current = epoch();
    waiting = waiting.filter(item => {
      if (item.epoch === current) return true;
      item.reject(new DOMException('Mail session changed before dispatch', 'AbortError'));
      return false;
    });
    while (active < concurrency && waiting.length) {
      const first = waiting[0];
      const batch: Item[] = [];
      waiting = waiting.filter(item => {
        if (item.epoch === first.epoch && item.read === first.read && batch.length < batchSize) {
          batch.push(item); return false;
        }
        return true;
      });
      active++;
      void Promise.resolve().then(() => {
        if (epoch() !== first.epoch) throw new DOMException('Mail session changed before dispatch', 'AbortError');
        return send([...new Set(batch.map(item => item.id))], first.read, [...new Set(batch.map(item => item.account))]);
      }).then(result => { for (const item of batch) item.resolve(result); }, error => {
        for (const item of batch) item.reject(error);
      }).finally(() => { active--; schedule(); });
    }
  };
  const schedule = () => {
    if (!scheduled && waiting.length) { scheduled = true; queueMicrotask(drain); }
  };
  return (id: string, read: boolean, account: string): Promise<unknown> => new Promise((resolve, reject) => {
    waiting.push({ id, read, account, epoch: epoch(), resolve, reject });
    schedule();
  });
}

export const sendMailRead = createMailReadBatch((ids, read, accounts) => api.bulkRead(ids, read, accounts), getAuthEpoch);
