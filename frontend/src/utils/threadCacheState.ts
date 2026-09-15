export function mergeThreadCacheField<T extends object, K extends keyof T>(
  cachedMessages: T[],
  field: K,
  value: T[K],
) {
  return cachedMessages.map(message => ({ ...message, [field]: value }));
}
