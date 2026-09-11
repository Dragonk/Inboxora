// Serialize star-flag writes per physical message. Provider writes may complete
// out of order, so same-copy intents must reach the provider in local order.
const tails = new Map();
const versions = new Map();

export function queueStarStateMutation(id, starred, request) {
  const key = String(id);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  const previous = tails.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => request(starred));
  const settled = task.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  tails.set(key, settled);
  return { version, promise: settled };
}

export function isLatestStarStateMutation(id, version) {
  return versions.get(String(id)) === version;
}

export function resetStarStateMutationsForTest() {
  tails.clear();
  versions.clear();
}
