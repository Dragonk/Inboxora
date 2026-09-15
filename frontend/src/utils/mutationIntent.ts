const versions = new Map<string, number>();

function nextVersion(key: string): number {
  const currentVersion = versions.get(key);
  return currentVersion === undefined ? 1 : currentVersion + 1;
}

export function beginMutation(key: string): number {
  const version = nextVersion(key);
  versions.set(key, version);
  return version;
}

export function isLatestMutation(key: string, version: string | number): boolean {
  if (typeof version !== 'number') return false;
  return versions.get(key) === version;
}

export function invalidateMutation(key: string): void {
  versions.set(key, nextVersion(key));
}

export function resetMutationIntentsForTest(): void {
  versions.clear();
}
