export function mergeThreadCacheField(cachedMessages, field, value) {
  return cachedMessages.map(message => ({ ...message, [field]: value }));
}
