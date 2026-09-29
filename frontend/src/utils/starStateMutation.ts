import { getAuthEpoch, isCurrentAuthEpoch, onAuthEpochChange } from './authEpoch.ts';
import { beginMailFlagIntent, settleMailFlagIntent, pendingMailFlag, resetMailFlagIntentsForTest } from './mailFlagIntents.ts';

// Serialize each physical copy while preserving the newest queued user intent.
const tails = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
let sequence = 0;
onAuthEpochChange(() => { tails.clear(); versions.clear(); });

export function queueStarStateMutation(id: string, starred: boolean, request: (starred: boolean) => Promise<unknown>) {
  const key = String(id);
  const version = ++sequence;
  const epoch = getAuthEpoch();
  versions.set(key, version);
  const intent = beginMailFlagIntent(key, 'is_starred', starred);
  const previous = tails.get(key);
  const task = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
    .then(() => {
      if (!isCurrentAuthEpoch(epoch)) throw new Error('Mail action belongs to an expired session');
      return request(starred);
    }).then(response => {
      settleMailFlagIntent(key, 'is_starred', intent, response);
      return response;
    }, error => {
      settleMailFlagIntent(key, 'is_starred', intent, error, true);
      throw error;
    });
  const settled = task.finally(() => { if (tails.get(key) === settled) tails.delete(key); });
  tails.set(key, settled);
  return { version, promise: settled };
}
export function isLatestStarStateMutation(id: string, version: number) { return versions.get(String(id)) === version; }
export function pendingStarState(id: string) { return pendingMailFlag(String(id), 'is_starred'); }
export function resetStarStateMutationsForTest() { tails.clear(); versions.clear(); resetMailFlagIntentsForTest(); }

/** Snapshot the mutation clock before resolving whole-thread membership. */
export function currentStarStateMutationVersion(id: string) { return versions.get(String(id)); }
export function starStateMutationRevision() { return sequence; }
