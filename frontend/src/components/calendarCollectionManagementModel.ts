import { collectionDeletionAllowed, type CollectionDeletionCapability } from './collectionDeletionModel.ts';

export type NativeCalendarOperationState = 'confirmed' | 'pending' | 'retryable' | 'outcome_unknown' | 'conflict' | 'failed';

export interface NativeCalendarOperationResponse {
  state?: NativeCalendarOperationState;
  operationId?: string | null;
  collectionId?: string | null;
  localCalendarId?: string | null;
  retryAfterSeconds?: number | null;
  code?: string | null;
}

/** Only a durable confirmed operation may refresh local projections or offer a new intent. */
export function isConfirmedNativeCalendarOperation(response: NativeCalendarOperationResponse): boolean {
  return response.state === 'confirmed';
}

/** Unknown/conflicting operations have already reached the durable journal; never offer a blind repeat. */
export function nativeCalendarOperationBlocksRetry(response: NativeCalendarOperationResponse): boolean {
  return response.state === 'pending' || response.state === 'retryable' || response.state === 'outcome_unknown' || response.state === 'conflict';
}

/** Eligibility is ultimately verified from fresh provider metadata by the server. */
export function providerCalendarDeleteAllowed(input: { id?: string | null; source?: string | null; collection_id?: string | null; deletion?: CollectionDeletionCapability | null }): boolean {
  return collectionDeletionAllowed(input.deletion) && (input.source === 'caldav'
    ? typeof input.id === 'string' && input.id.length > 0
    : (input.source === 'google' || input.source === 'microsoft') && typeof input.collection_id === 'string' && input.collection_id.length > 0);
}

export function operationKey(): string {
  return crypto.randomUUID();
}
