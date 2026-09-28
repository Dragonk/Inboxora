export function mergeThreadCacheField<T extends object, K extends keyof T>(
  cachedMessages: T[],
  field: K,
  value: T[K],
) {
  return cachedMessages.map(message => ({ ...message, [field]: value }));
}

/** Replace stale membership, retaining newer cached fields from independent actions. */
export function mergeThreadReadSnapshot<T extends { id: string; is_read?: boolean }>(
  cachedMessages: readonly T[] | undefined,
  resolvedMessages: readonly T[],
  read: boolean,
): T[] {
  const cachedById = new Map(cachedMessages?.map(message => [message.id, message]));
  return resolvedMessages.map(message => ({ ...message, ...cachedById.get(message.id), is_read: read }));
}
