/** Only explicit preflight/domain refusals prove no new queue write occurred. */
export function isDefiniteQueueRejection(error: { status?: number; code?: string }): boolean {
  if (error.code === 'SCHEDULE_KEY_MISMATCH') return false;
  return error.status === 400 || error.status === 413 || error.status === 422
    || (error.status === 409 && (error.code === 'SCHEDULE_QUEUE_FULL' || error.code === 'SCHEDULE_CHANGED'))
    || (error.status === 404 && error.code === 'SCHEDULE_ACCOUNT_MISSING');
}
