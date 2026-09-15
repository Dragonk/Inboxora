// Serialize read-flag writes per normalized native message. IMAP/provider writes may
// complete out of order; chaining makes the newest local intent the last server write.
type PendingReadStateIntent = {
  version: number;
  read: boolean;
};

const tails = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
const pendingIntents = new Map<string, PendingReadStateIntent>();

export function queueReadStateMutation(id: string, read: boolean, request: (read: boolean) => Promise<unknown>) {
  const key = String(id);
  const currentVersion = versions.get(key);
  const version = currentVersion === undefined ? 1 : currentVersion + 1;
  versions.set(key, version);
  pendingIntents.set(key, { version, read });

  const previous = tails.get(key);
  const task = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
    .then(() => request(read));
  const settled = task.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);

    const pendingIntent = pendingIntents.get(key);
    if (pendingIntent !== undefined && pendingIntent.version === version) pendingIntents.delete(key);
  });
  tails.set(key, settled);
  return { version, promise: settled };
}

export function isLatestReadStateMutation(id: string, version: number) {
  return versions.get(String(id)) === version;
}

export function pendingReadState(id: string) {
  const pendingIntent = pendingIntents.get(String(id));
  return pendingIntent === undefined ? undefined : pendingIntent.read;
}

export function resetReadStateMutationsForTest() {
  pendingIntents.clear();
  tails.clear();
  versions.clear();
}
