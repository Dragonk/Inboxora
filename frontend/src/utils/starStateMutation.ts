// Serialize star-flag writes per physical message. Provider writes may complete
// out of order, so same-copy intents must reach the provider in local order.
const tails = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();

export function queueStarStateMutation(id: string, starred: boolean, request: (starred: boolean) => Promise<unknown>) {
  const key = String(id);
  const currentVersion = versions.get(key);
  const version = currentVersion === undefined ? 1 : currentVersion + 1;
  versions.set(key, version);

  const previous = tails.get(key);
  const task = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
    .then(() => request(starred));
  const settled = task.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  tails.set(key, settled);
  return { version, promise: settled };
}

export function isLatestStarStateMutation(id: string, version: number) {
  return versions.get(String(id)) === version;
}

export function resetStarStateMutationsForTest() {
  tails.clear();
  versions.clear();
}
