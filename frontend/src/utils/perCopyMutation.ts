// Track the newest mutation intent independently for each visible logical copy
// and semantic action lane. Independent actions (for example read and star)
// must not cancel one another; repeated intent in one lane still does.
const versions = new Map<string, number>();

type MutationRequest<T> = () => T | Promise<T>;
type VersionToken = string | number;

function normalizeArgs<T>(
  laneOrRequest: string | MutationRequest<T>,
  maybeRequest?: MutationRequest<T> | undefined,
): [string, MutationRequest<T> | undefined] {
  return typeof laneOrRequest === 'function'
    ? ['default', laneOrRequest]
    : [laneOrRequest, maybeRequest];
}

function keyFor(id: string, lane: string | number) {
  return `${String(id)}:${String(lane)}`;
}

// NOTE: `version` is intentionally left untyped. Its true return type is
// `string | number` (the 'default' lane returns the numeric counter), which
// cannot be assigned to queuePerCopyMutation's public `version: string`.
// Widening that declaration requires MessageList.tsx's onResolution type to
// accept `string | number` as well, which lives outside this file.
function tokenFor(lane: string, version) {
  return lane === 'default' ? version : `${String(lane)}:${version}`;
}

function versionFor(lane: string | number, version: VersionToken): VersionToken {
  if (typeof version !== 'string') return version;
  const prefix = `${String(lane)}:`;
  return version.startsWith(prefix) ? Number(version.slice(prefix.length)) : version;
}

function laneAndVersion(
  laneOrVersion: string | number,
  maybeVersion: VersionToken | undefined = undefined,
): [string | number, VersionToken] {
  if (maybeVersion !== undefined) return [laneOrVersion, maybeVersion];
  if (typeof laneOrVersion === 'string') {
    const separator = laneOrVersion.lastIndexOf(':');
    if (separator > 0) return [laneOrVersion.slice(0, separator), Number(laneOrVersion.slice(separator + 1))];
  }
  return ['default', laneOrVersion];
}

export function queuePerCopyMutation<T>(
  id: string,
  laneOrRequest: string | MutationRequest<T>,
  maybeRequest?: MutationRequest<T> | undefined,
): { version: string; promise: Promise<T> } {
  const [lane, request] = normalizeArgs(laneOrRequest, maybeRequest);
  const key = keyFor(id, lane);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  return { version: tokenFor(lane, version), promise: Promise.resolve().then(request) };
}

export function isLatestPerCopyMutation(
  id: string,
  laneOrVersion: string | number,
  maybeVersion: VersionToken | undefined = undefined,
): boolean {
  const [lane, version] = laneAndVersion(laneOrVersion, maybeVersion);
  return versions.get(keyFor(id, lane)) === versionFor(lane, version);
}

// Invalidate a deferred continuation without creating a new request intent.
export function invalidatePerCopyMutation(
  id: string,
  laneOrVersion: string | number,
  maybeVersion: VersionToken | undefined = undefined,
): void {
  const [lane, version] = laneAndVersion(laneOrVersion, maybeVersion);
  const key = keyFor(id, lane);
  const numericVersion = versionFor(lane, version);
  if (versions.get(key) === numericVersion && typeof numericVersion === 'number') {
    versions.set(key, numericVersion + 1);
  }
}

export function resetPerCopyMutationsForTest() {
  versions.clear();
}
