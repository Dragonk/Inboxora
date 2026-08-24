import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

// Outlook Thread-Index root extraction — shared between ingest and rebuild paths
// so both produce IDENTICAL providerThreadId for the same Outlook thread.
// Base64 decode → validate 22-byte root + 5-byte child blocks → return hex of root.
function outlookConversationRoot(value) {
  if (!value) return null;
  try {
    const raw = Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
    if (raw.length < 22 || (raw.length - 22) % 5 !== 0) return null;
    return raw.subarray(0, 22).toString('hex');
  } catch { return null; }
}

export function providerIdentityForCopy(copy) {
  const provider = copy.provider_namespace?.split(':')[0] || null;
  // P0 fix: only Gmail X-GM-THRID (persisted as provider_thread_id) is strong evidence.
  // Outlook Thread-Index (persisted as conversation_thread_index) is NOT strong — it's a
  // client-generated base64 blob, not server-validated, and its raw value changes as the
  // thread grows. Using the raw header as providerThreadId during rebuild fragments Outlook
  // threads because each reply has a different raw Thread-Index value.
  //
  // However, the 22-byte ROOT of Thread-Index IS a stable conversation identifier
  // (all replies in the same Outlook thread share the same 22-byte root). Extract it
  // as providerThreadId for Outlook so initial ingest, retry, and rebuild all produce
  // the SAME providerThreadId — satisfying P0-03/04 consistency requirement.
  const hasGmailThreadId = Boolean(copy.provider_thread_id);
  const outlookRoot = provider === 'outlook' && !hasGmailThreadId
    ? outlookConversationRoot(copy.conversation_thread_index)
    : null;
  const effectiveProviderThreadId = hasGmailThreadId
    ? copy.provider_thread_id
    : outlookRoot;
  return {
    provider,
    providerMessageId: copy.provider_message_id || null,
    providerThreadId: effectiveProviderThreadId,
    namespace: copy.provider_namespace || null,
    threadIndex: copy.conversation_thread_index || null,
    threadTopic: copy.conversation_thread_topic || null,
    references: normalizeMessageIdList(copy.thread_references),
    inReplyTo: normalizeMessageIdList(copy.in_reply_to).at(-1) || null,
    diagnostics: { reconstructed: true },
    isStrong: hasGmailThreadId && provider === 'gmail',
    source: hasGmailThreadId ? 'persisted-provider-thread' : outlookRoot ? 'outlook-conversation-index-root' : null,
  };
}
