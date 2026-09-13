// Track the newest mutation intent independently for each visible logical copy
// and semantic action lane. Independent actions (for example read and star)
// must not cancel one another; repeated intent in one lane still does.
const versions = new Map();

function normalizeArgs(laneOrRequest, maybeRequest) {
  return typeof laneOrRequest === 'function'
    ? ['default', laneOrRequest]
    : [laneOrRequest, maybeRequest];
}

function keyFor(id, lane) {
  return `${String(id)}:${String(lane)}`;
}

function tokenFor(lane, version) {
  return lane === 'default' ? version : `${String(lane)}:${version}`;
}

function versionFor(lane, version) {
  if (typeof version !== 'string') return version;
  const prefix = `${String(lane)}:`;
  return version.startsWith(prefix) ? Number(version.slice(prefix.length)) : version;
}

function laneAndVersion(laneOrVersion, maybeVersion) {
  if (maybeVersion !== undefined) return [laneOrVersion, maybeVersion];
  if (typeof laneOrVersion === 'string') {
    const separator = laneOrVersion.lastIndexOf(':');
    if (separator > 0) return [laneOrVersion.slice(0, separator), Number(laneOrVersion.slice(separator + 1))];
  }
  return ['default', laneOrVersion];
}

export function queuePerCopyMutation(id, laneOrRequest, maybeRequest) {
  const [lane, request] = normalizeArgs(laneOrRequest, maybeRequest);
  const key = keyFor(id, lane);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  return { version: tokenFor(lane, version), promise: Promise.resolve().then(request) };
}

export function isLatestPerCopyMutation(id, laneOrVersion, maybeVersion) {
  const [lane, version] = laneAndVersion(laneOrVersion, maybeVersion);
  return versions.get(keyFor(id, lane)) === versionFor(lane, version);
}

// Invalidate a deferred continuation without creating a new request intent.
export function invalidatePerCopyMutation(id, laneOrVersion, maybeVersion) {
  const [lane, version] = laneAndVersion(laneOrVersion, maybeVersion);
  const key = keyFor(id, lane);
  const numericVersion = versionFor(lane, version);
  if (versions.get(key) === numericVersion) versions.set(key, numericVersion + 1);
}

export function resetPerCopyMutationsForTest() {
  versions.clear();
}
