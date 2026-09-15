// Track the newest mutation intent independently for each visible logical copy
// and semantic action lane. Independent actions (for example read and star)
// must not cancel one another; repeated intent in one lane still does.
const versions = new Map<string, number>();

type MutationRequest<T> = () => T | Promise<T>;
type MutationResolution<T> = { version: string; promise: Promise<T> };
type VersionToken = string | number;
type MutationArguments<T> = [request: MutationRequest<T>] | [lane: string, request: MutationRequest<T>];
type VersionArguments = [version: VersionToken] | [lane: string, version: VersionToken];

function keyFor(id: string, lane: string): string {
  return `${id}:${lane}`;
}

function tokenFor(lane: string, version: number): string {
  return `${lane}:${version}`;
}

function splitToken(token: string): [string, number] {
  const separator = token.lastIndexOf(':');
  if (separator < 1) {
    throw new TypeError('Mutation version must include its action lane.');
  }

  return [token.slice(0, separator), Number(token.slice(separator + 1))];
}

function normalizeRequest<T>(arguments_: MutationArguments<T>): [string, MutationRequest<T>] {
  if (arguments_.length === 1) {
    return ['default', arguments_[0]];
  }

  return arguments_;
}

function normalizeVersion(arguments_: VersionArguments): [string, number] {
  if (arguments_.length === 1) {
    const [token] = arguments_;
    return typeof token === 'string' ? splitToken(token) : ['default', token];
  }

  const [lane, token] = arguments_;
  if (typeof token === 'number') {
    return [lane, token];
  }

  const prefix = `${lane}:`;
  if (!token.startsWith(prefix)) {
    return [lane, Number.NaN];
  }

  return [lane, Number(token.slice(prefix.length))];
}

export function queuePerCopyMutation<T>(
  id: string,
  ...arguments_: MutationArguments<T>
): MutationResolution<T> {
  const [lane, mutationRequest] = normalizeRequest(arguments_);
  const key = keyFor(id, lane);
  const version = (versions.get(key) ?? 0) + 1;
  versions.set(key, version);

  return {
    version: tokenFor(lane, version),
    promise: Promise.resolve().then(mutationRequest),
  };
}

export function isLatestPerCopyMutation(
  id: string,
  ...arguments_: VersionArguments
): boolean {
  const [lane, version] = normalizeVersion(arguments_);
  return versions.get(keyFor(id, lane)) === version;
}

// Invalidate a deferred continuation without creating a new request intent.
export function invalidatePerCopyMutation(
  id: string,
  ...arguments_: VersionArguments
): void {
  const [lane, version] = normalizeVersion(arguments_);
  const key = keyFor(id, lane);
  if (versions.get(key) === version) {
    versions.set(key, version + 1);
  }
}

export function resetPerCopyMutationsForTest(): void {
  versions.clear();
}
