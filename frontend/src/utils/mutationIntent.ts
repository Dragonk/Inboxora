const versions = new Map();

export function beginMutation(key) {
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  return version;
}

export function isLatestMutation(key, version) {
  return versions.get(key) === version;
}

export function invalidateMutation(key) {
  versions.set(key, (versions.get(key) || 0) + 1);
}

export function resetMutationIntentsForTest() {
  versions.clear();
}
