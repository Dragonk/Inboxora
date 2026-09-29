import type { DavCollectionDeleteResult } from './davCollectionLifecycle.js';

/** Preserve uncertainty at the HTTP boundary: only completed cleanup is success. */
export function davCollectionDeletionResponse(result: DavCollectionDeleteResult) {
  return {
    status: result.status === 'deleted' ? 200 : result.status === 'unknown' ? 202 : result.status === 'refused' ? 403 : 404,
    body: {
      state: result.status === 'deleted' ? 'confirmed' : result.status === 'unknown' ? 'outcome_unknown' : 'failed',
      operationId: result.operationId,
      code: result.status === 'deleted' ? undefined : result.status === 'unknown' ? 'DAV_DELETE_UNRESOLVED' : result.status === 'refused' ? 'COLLECTION_DELETE_UNSUPPORTED' : 'RESOURCE_NOT_FOUND',
      reason: result.reason,
      error: result.status === 'refused' || result.status === 'not_found' ? result.reason : undefined,
    },
  };
}

export function validCollectionDeletionIntent(body: { confirmName?: unknown; idempotencyKey?: unknown } | undefined): body is { confirmName: string; idempotencyKey: string } {
  return typeof body?.confirmName === 'string' && Boolean(body.confirmName.trim()) && body.confirmName.length <= 255
    && typeof body.idempotencyKey === 'string' && Boolean(body.idempotencyKey.trim())
    && body.idempotencyKey === body.idempotencyKey.trim() && body.idempotencyKey.length <= 200;
}
