import type { StoreMessageRow } from '../store/index.ts';

export interface MailListSnapshot { messages: StoreMessageRow[]; total: number }
type Params = Record<string, string | number | boolean | null | undefined>;
type Ticket = { key: string; epoch: number; revision: number; request: number; accountId: string | null };

/** Bounded, memory-only first-page snapshots. They are never a substitute for revalidation. */
export function createMailListCache({ maxEntries = 8, maxRows = 1000, maxAgeMs = 60_000, now = Date.now } = {}) {
  const entries = new Map<string, { value: MailListSnapshot; at: number; accountId: string | null }>();
  const latest = new Map<string, number>();
  let epoch = -1;
  let revision = 0;
  let sequence = 0;
  let rowCount = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) rowCount -= entry.value.messages.length;
    entries.delete(key);
  };
  const clear = () => {
    revision += 1;
    entries.clear(); latest.clear(); rowCount = 0;
  };
  const enter = (nextEpoch: number) => {
    if (epoch !== nextEpoch) { clear(); epoch = nextEpoch; }
  };
  const keyFor = (params: Params) => JSON.stringify(Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null).sort(([a], [b]) => a.localeCompare(b)));
  return {
    clear,
    invalidate(accountId?: string) {
      // Fence all in-flight writes even when only one account's stored snapshots
      // are evicted: a pre-mutation response must not repopulate an obsolete list.
      revision += 1; latest.clear();
      for (const [key, entry] of entries) {
        if (!accountId || !entry.accountId || entry.accountId === accountId) remove(key);
      }
    },
    get(params: Params, authEpoch: number): MailListSnapshot | undefined {
      enter(authEpoch);
      const key = keyFor(params);
      const entry = entries.get(key);
      if (!entry) return undefined;
      const age = now() - entry.at;
      if (age < 0 || age >= maxAgeMs) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    begin(params: Params, authEpoch: number): Ticket | undefined {
      enter(authEpoch);
      // Long infinite-scroll windows and offset pages should not evict all of
      // the useful navigation snapshots or retain an unbounded mailbox history.
      if (Number(params.offset || 0) !== 0 || Number(params.limit || 50) > 500) return undefined;
      const key = keyFor(params);
      const request = ++sequence;
      latest.set(key, request);
      return { key, epoch, revision, request, accountId: typeof params.accountId === 'string' ? params.accountId : null };
    },
    finish(ticket: Ticket | undefined, value?: MailListSnapshot): void {
      if (!ticket || ticket.epoch !== epoch || ticket.revision !== revision || latest.get(ticket.key) !== ticket.request) return;
      latest.delete(ticket.key);
      if (!value || value.messages.length > maxRows) return;
      remove(ticket.key);
      entries.set(ticket.key, { value, at: now(), accountId: ticket.accountId });
      rowCount += value.messages.length;
      while (entries.size > maxEntries || rowCount > maxRows) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
    },
  };
}

export const mailListCache = createMailListCache();
export const invalidateMailListCache = (accountId?: string): void => mailListCache.invalidate(accountId);
