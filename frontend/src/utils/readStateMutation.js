// Serialize read-flag writes per normalized native message.  IMAP/provider writes may
// complete out of order; chaining makes the newest local intent the last server write.
const tails = new Map();
const versions = new Map();

export function queueReadStateMutation(id, read, request) {
  const key = String(id);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  const previous = tails.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => request(read));
  const settled = task.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  tails.set(key, settled);
  return { version, promise: settled };
}

export function isLatestReadStateMutation(id, version) {
  return versions.get(String(id)) === version;
}

export function resetReadStateMutationsForTest() {
  tails.clear();
  versions.clear();
}
