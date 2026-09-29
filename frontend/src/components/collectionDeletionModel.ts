/** Server-derived rights; absence is deliberately not permission to delete remotely. */
export interface CollectionDeletionCapability { supported: boolean; reason?: string }
export interface CollectionDeleteResponse { state?: string; code?: string | null }
export interface CollectionDeleteIntent { id: string; name: string; idempotencyKey: string; response: CollectionDeleteResponse }

export function collectionDeletionAllowed(capability?: CollectionDeletionCapability | null): boolean {
  return capability?.supported === true;
}

export function collectionDeleteConfirmed(response: CollectionDeleteResponse | null | undefined): boolean {
  return response?.state === 'confirmed';
}

/** Keep the same request identity across navigation; malformed storage must block a new delete. */
export function readCollectionDeleteIntents(value: string | null): Record<string, CollectionDeleteIntent> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_COLLECTION_DELETE_INTENTS');
  const result: Record<string, CollectionDeleteIntent> = {};
  for (const [id, item] of Object.entries(parsed)) {
    if (!item || typeof item !== 'object' || !('id' in item) || item.id !== id || !('name' in item) || typeof item.name !== 'string'
      || !('idempotencyKey' in item) || typeof item.idempotencyKey !== 'string' || !item.idempotencyKey
      || !('response' in item) || !item.response || typeof item.response !== 'object') throw new Error('INVALID_COLLECTION_DELETE_INTENT');
    result[id] = { id, name: item.name, idempotencyKey: item.idempotencyKey, response: { state: 'outcome_unknown' } };
  }
  return result;
}

export async function sendCollectionDeletion(intent: CollectionDeleteIntent, options: {
  current: () => boolean;
  persist: (intent: CollectionDeleteIntent) => void;
  send: (intent: CollectionDeleteIntent) => Promise<CollectionDeleteResponse | null>;
  confirmed: (intent: CollectionDeleteIntent) => void;
}): Promise<boolean> {
  if (!options.current()) return false;
  // Storage failure prevents dispatch: a remote request must never lose its idempotency key.
  options.persist(intent);
  try {
    const response = await options.send(intent);
    if (!options.current()) return false;
    if (collectionDeleteConfirmed(response)) { options.confirmed(intent); return true; }
    options.persist({ ...intent, response: response ?? { state: 'outcome_unknown' } });
    return false;
  } catch (error) {
    if (options.current()) options.persist({ ...intent, response: { state: 'outcome_unknown' } });
    throw error;
  }
}
