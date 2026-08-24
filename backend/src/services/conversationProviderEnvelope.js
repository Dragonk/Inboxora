import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

export function providerIdentityForCopy(copy) {
  const provider = copy.provider_namespace?.split(':')[0] || null;
  // P0 fix: only Gmail X-GM-THRID (persisted as provider_thread_id) is strong evidence.
  // Outlook Thread-Index (persisted as conversation_thread_index) is NOT strong — it's a
  // client-generated base64 blob, not server-validated, and its raw value changes as the
  // thread grows. Using the raw header as providerThreadId during rebuild fragments Outlook
  // threads because each reply has a different raw Thread-Index value.
  // Outlook Thread-Index is still available as threadIndex evidence (weak), but not as a
  // stable thread grouping key.
  const hasGmailThreadId = Boolean(copy.provider_thread_id);
  return {
    provider,
    providerMessageId: copy.provider_message_id || null,
    providerThreadId: hasGmailThreadId ? copy.provider_thread_id : null,
    namespace: copy.provider_namespace || null,
    threadIndex: copy.conversation_thread_index || null,
    threadTopic: copy.conversation_thread_topic || null,
    references: normalizeMessageIdList(copy.thread_references),
    inReplyTo: normalizeMessageIdList(copy.in_reply_to).at(-1) || null,
    diagnostics: { reconstructed: true },
    isStrong: hasGmailThreadId && provider === 'gmail',
    source: hasGmailThreadId ? 'persisted-provider-thread' : null,
  };
}
