import { normalizeMessageIdList } from './threading/normalizeMessageId.js';

interface AccountContext {
  imap_host?: unknown;
  imapHost?: unknown;
  [key: string]: unknown;
}

interface ConversationCopy extends AccountContext {
  provider_namespace?: unknown;
  provider_thread_id?: unknown;
  provider_message_id?: unknown;
  conversation_thread_index?: unknown;
  conversation_thread_topic?: unknown;
  thread_references?: unknown;
  in_reply_to?: unknown;
}

interface ProviderIdentity {
  provider: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  namespace: string | null;
  threadIndex: string | null;
  threadTopic: string | null;
  references: string[];
  inReplyTo: string | null;
  diagnostics: { reconstructed: true };
  isStrong: boolean;
  source: 'persisted-provider-thread' | 'outlook-conversation-index-root' | null;
  [key: string]: unknown;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function accountHost(accountContext: AccountContext | null | undefined): string {
  if (accountContext === null || accountContext === undefined) return '';

  const imapHost = nonEmptyString(accountContext.imap_host);
  if (imapHost !== null) return imapHost.toLowerCase();

  const legacyImapHost = nonEmptyString(accountContext.imapHost);
  if (legacyImapHost !== null) return legacyImapHost.toLowerCase();

  return '';
}

// Outlook Thread-Index root extraction — shared between ingest and rebuild paths
// so both produce IDENTICAL providerThreadId for the same Outlook thread.
// Base64 decode → validate 22-byte root + 5-byte child blocks → return hex of root.
function outlookConversationRoot(value: unknown): string | null {
  const threadIndex = nonEmptyString(value);
  if (threadIndex === null) return null;

  try {
    const raw = Buffer.from(threadIndex.replace(/\s+/g, ''), 'base64');
    if (raw.length < 22 || (raw.length - 22) % 5 !== 0) return null;
    return raw.subarray(0, 22).toString('hex');
  } catch {
    return null;
  }
}

export function providerIdentityForCopy(
  copy: ConversationCopy,
  accountContext: AccountContext | null | undefined = copy,
): ProviderIdentity {
  const namespace = nonEmptyString(copy.provider_namespace);
  const persistedProvider = namespace === null ? null : namespace.split(':')[0] || null;
  const host = accountHost(accountContext);
  const provider = persistedProvider || (
    /gmail|googlemail/.test(host) ? 'gmail' :
    /outlook|office365|exchange|hotmail|live\.com/.test(host) ? 'outlook' :
    null
  );
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
  const providerThreadId = nonEmptyString(copy.provider_thread_id);
  const hasGmailThreadId = provider === 'gmail' && providerThreadId !== null;
  const outlookRoot = provider === 'outlook'
    ? outlookConversationRoot(copy.conversation_thread_index)
    : null;
  const effectiveProviderThreadId = hasGmailThreadId ? providerThreadId : outlookRoot;
  const normalizedInReplyTo = normalizeMessageIdList(copy.in_reply_to);
  const inReplyTo = normalizedInReplyTo.length === 0
    ? null
    : normalizedInReplyTo[normalizedInReplyTo.length - 1];

  return {
    provider,
    providerMessageId: nonEmptyString(copy.provider_message_id),
    providerThreadId: effectiveProviderThreadId,
    namespace,
    threadIndex: nonEmptyString(copy.conversation_thread_index),
    threadTopic: nonEmptyString(copy.conversation_thread_topic),
    references: normalizeMessageIdList(copy.thread_references),
    inReplyTo,
    diagnostics: { reconstructed: true },
    isStrong: hasGmailThreadId,
    source: hasGmailThreadId
      ? 'persisted-provider-thread'
      : outlookRoot === null ? null : 'outlook-conversation-index-root',
  };
}
