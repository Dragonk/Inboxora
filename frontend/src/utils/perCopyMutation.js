// Track the newest mutation intent independently for each visible logical copy.
const versions = new Map();

export function queuePerCopyMutation(id, request) {
  const key = String(id);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  return { version, promise: Promise.resolve().then(request) };
}

export function isLatestPerCopyMutation(id, version) {
  return versions.get(String(id)) === version;
}

// Invalidate a deferred continuation without creating a new request intent.
export function invalidatePerCopyMutation(id, version) {
  const key = String(id);
  if (versions.get(key) === version) versions.set(key, version + 1);
}

export function resetPerCopyMutationsForTest() {
  versions.clear();
}
