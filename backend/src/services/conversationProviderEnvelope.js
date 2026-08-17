import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

export function providerIdentityForCopy(copy) {
  const provider = copy.provider_namespace?.split(':')[0] || null;
  return {
    provider,
    providerMessageId: copy.provider_message_id || null,
    providerThreadId: copy.provider_thread_id || copy.conversation_thread_index || null,
    namespace: copy.provider_namespace || null,
    threadIndex: copy.conversation_thread_index || null,
    threadTopic: copy.conversation_thread_topic || null,
    references: normalizeMessageIdList(copy.thread_references),
    inReplyTo: normalizeMessageIdList(copy.in_reply_to).at(-1) || null,
    diagnostics: { reconstructed: true },
    isStrong: Boolean(copy.provider_thread_id || copy.conversation_thread_index),
    source: copy.provider_thread_id ? 'persisted-provider-thread' : copy.conversation_thread_index ? 'persisted-outlook-thread-index' : null,
  };
}
