// Serialize read-flag writes per normalized native message.  IMAP/provider writes may
// complete out of order; chaining makes the newest local intent the last server write.
const tails = new Map();
const versions = new Map();
const pendingIntents = new Map();

export function queueReadStateMutation(id, read, request) {
  const key = String(id);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  pendingIntents.set(key, { version, read });
  const previous = tails.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => request(read));
  const settled = task.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
    if (pendingIntents.get(key)?.version === version) pendingIntents.delete(key);
  });
  tails.set(key, settled);
  return { version, promise: settled };
}

export function isLatestReadStateMutation(id, version) {
  return versions.get(String(id)) === version;
}

export function pendingReadState(id) {
  return pendingIntents.get(String(id))?.read;
}

export function resetReadStateMutationsForTest() {
  pendingIntents.clear();
  tails.clear();
  versions.clear();
}
