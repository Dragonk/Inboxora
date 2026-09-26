import { GraphApiError, graphGetWithHeaders, graphPost, graphUrl, IMMUTABLE_ID_PREFERENCE } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';

interface ConversionResponse { value?: Array<{ sourceId?: string; targetId?: string }> }

/** Reject absent, partial and ambiguous identity conversions instead of treating them as deletion. */
export function singleConvertedId(sourceId: string, response: ConversionResponse | null): string {
  if (!response || !Array.isArray(response.value)) throw new Error('Graph returned no ID conversion collection');
  const targets = [...new Set(response.value
    .filter(item => item.sourceId === sourceId && typeof item.targetId === 'string' && item.targetId.trim())
    .map(item => item.targetId!))];
  if (targets.length !== 1) throw new Error('Graph identity conversion is missing or ambiguous');
  return targets[0]!;
}

/** A conversion succeeds only when Graph has accepted the explicitly declared ID format. */
async function translate(api: GraphApiOptions, id: string, source: string, target: string): Promise<string> {
  return singleConvertedId(id, await graphPost<ConversionResponse>(api, '/me/translateExchangeIds', {
    inputIds: [id], sourceIdType: source, targetIdType: target,
  }));
}

export type GraphStableLocation =
  | { kind: 'found'; id: string; parentFolderId: string; immutableId: string }
  | { kind: 'gone'; immutableId: string };

/**
 * Resolve this specific physical item, without an RFC Message-ID search.
 * The account preference chooses a conversion format, not deletion authority.
 * Validate immutable-format inputs by a cross-format round trip, so a historical
 * mutable id cannot be authorized by merely setting a connection-level flag.
 */
export async function readGraphStableLocation(api: GraphApiOptions, storedId: string): Promise<GraphStableLocation> {
  let stableId: string;
  if (api.immutableIds) {
    const restId = await translate(api, storedId, 'restImmutableEntryId', 'restId');
    stableId = await translate(api, restId, 'restId', 'restImmutableEntryId');
    if (stableId !== storedId) throw new Error('Stored Graph ID does not match its immutable format');
  } else {
    stableId = await translate(api, storedId, 'restId', 'restImmutableEntryId');
  }

  let current: { id?: string; parentFolderId?: string };
  try {
    current = await graphGetWithHeaders<{ id?: string; parentFolderId?: string }>(
      { ...api, immutableIds: true },
      graphUrl(`/me/messages/${encodeURIComponent(stableId)}`, { $select: 'id,parentFolderId' }),
      { Prefer: IMMUTABLE_ID_PREFERENCE },
    );
  } catch (error) {
    // Only this request, for a successfully established stable item identity,
    // may classify absence. A conversion 404/401/429 is NOT a missing message.
    if (error instanceof GraphApiError && error.status === 404) return { kind: 'gone', immutableId: stableId };
    throw error;
  }
  if (current.id !== stableId || typeof current.parentFolderId !== 'string' || !current.parentFolderId.trim()) {
    throw new Error('Graph returned an invalid stable message location');
  }
  const currentId = api.immutableIds ? stableId
    : await translate(api, stableId, 'restImmutableEntryId', 'restId');
  return { kind: 'found', id: currentId, parentFolderId: current.parentFolderId, immutableId: stableId };
}
