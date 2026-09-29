import { getAuthEpoch, isCurrentAuthEpoch, onAuthEpochChange } from './authEpoch.ts';
import { beginMailFlagIntent, settleMailFlagIntent, pendingMailFlag, resetMailFlagIntentsForTest } from './mailFlagIntents.ts';

// Serialize each physical copy while preserving the newest queued user intent.
const tails = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
let sequence = 0;
onAuthEpochChange(() => { tails.clear(); versions.clear(); });

export function queueReadStateMutation(id: string, read: boolean, request: (read: boolean) => Promise<unknown>) {
  const key = String(id);
  const version = ++sequence;
  const epoch = getAuthEpoch();
  versions.set(key, version);
  const intent = beginMailFlagIntent(key, 'is_read', read);
  const previous = tails.get(key);
  const task = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
    .then(() => {
      if (!isCurrentAuthEpoch(epoch)) throw new Error('Mail action belongs to an expired session');
      return request(read);
    }).then(response => {
      settleMailFlagIntent(key, 'is_read', intent, response);
      return response;
    }, error => {
      settleMailFlagIntent(key, 'is_read', intent, error, true);
      throw error;
    });
  const settled = task.finally(() => { if (tails.get(key) === settled) tails.delete(key); });
  tails.set(key, settled);
  return { version, promise: settled };
}
export function isLatestReadStateMutation(id: string, version: number) { return versions.get(String(id)) === version; }
export function pendingReadState(id: string) { return pendingMailFlag(String(id), 'is_read'); }
export function resetReadStateMutationsForTest() { tails.clear(); versions.clear(); resetMailFlagIntentsForTest(); }

/** Snapshot the mutation clock before deferred UI work or thread resolution. */
export function currentReadStateMutationVersion(id: string) { return versions.get(String(id)); }
export function readStateMutationRevision() { return sequence; }
