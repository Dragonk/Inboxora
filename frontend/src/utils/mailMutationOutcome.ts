import i18n from 'i18next';

export type MailMutationStatus = 'confirmed' | 'pending' | 'failed';

/** HTTP success describes the request; only per-item confirmation describes a write. */
export function mailMutationStatus(response: unknown, id: string): MailMutationStatus {
  if (!response || typeof response !== 'object') return 'pending';
  const value = response as Record<string, unknown>;
  const includes = (field: string) => Array.isArray(value[field]) && value[field].includes(id);
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes : [];
  const outcome = outcomes.find((item: unknown) => typeof item === 'object' && item !== null && 'id' in item && item.id === id);
  const status: unknown = outcome && typeof outcome === 'object' && 'status' in outcome ? outcome.status : undefined;
  if (includes('failed') || ['failed', 'permanent', 'conflict', 'cancelled'].includes(String(status)) || value.ok === false) return 'failed';
  if (includes('pending')) return 'pending';
  if (status !== undefined) return ['confirmed', 'succeeded', 'updated'].includes(String(status)) ? 'confirmed' : 'pending';
  if (includes('updated')) return 'confirmed';
  const structured = ['updated', 'pending', 'failed', 'outcomes'].some(key => key in value);
  return !structured && value.ok === true ? 'confirmed' : 'pending';
}

export function mailMutationFailure(error: unknown): 'failed' | 'pending' {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'failed' : 'pending';
}

/** Use the initialized i18next singleton without importing browser bootstrap. */
export function mutationNotice(status: 'pending' | 'failed') {
  if (status === 'pending') return {
    title: i18n.isInitialized ? String(i18n.t('mailStateChange.pendingTitle')) : 'Mail change pending',
    body: i18n.isInitialized ? String(i18n.t('mailStateChange.pendingBody')) : 'The mail provider has not confirmed this change yet. The current mailbox state will be checked again.',
  };
  return {
    title: i18n.isInitialized ? String(i18n.t('mailStateChange.failedTitle')) : 'Mail change failed',
    body: i18n.isInitialized ? String(i18n.t('mailStateChange.failedBody')) : 'The mail provider could not apply this change. The previous state has been restored.',
  };
}
