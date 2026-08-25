import { createHash } from 'crypto';
import { decodeMimeWords } from './messageParser.js';
import { normalizeMessageId } from './threading/normalizeMessageId.js';

const REPLY_PREFIX_RE = /^(?:(?:re|odp|aw|sv|vs|antw|ant|ref|rif|ynt|tr)\s*:\s*)+/i;
const FORWARD_PREFIX_RE = /^(?:fwd|fw|przek)\s*:\s*/i;

export function canonicalConversationSubject(subject = '') {
  const decoded = decodeMimeWords(String(subject || '')).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (FORWARD_PREFIX_RE.test(decoded)) return decoded.toLowerCase();
  return decoded.replace(REPLY_PREFIX_RE, '').trim().toLowerCase();
}

function addressOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.match(/<([^>]+)>/)?.[1]?.toLowerCase() || value.trim().toLowerCase();
  return value.email?.toLowerCase() || value.address?.toLowerCase() || null;
}

export function classifyDirection(message, identities = []) {
  const mine = new Set(identities.map(addressOf).filter(Boolean));
  const from = addressOf(message.from_email || message.from || message.sender);
  const recipients = [message.to_addresses, message.cc_addresses, message.delivery_addresses].flatMap(value => Array.isArray(value) ? value : []).map(addressOf).filter(Boolean);
  const fromMine = from ? mine.has(from) : false;
  const externalRecipient = recipients.some(address => !mine.has(address));
  if (!from && !recipients.length) return 'unknown';
  if (fromMine && !externalRecipient) return 'self';
  if (fromMine) return 'outgoing';
  if (recipients.some(address => mine.has(address))) return 'incoming';
  return 'unknown';
}

export function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function logicalMessageIdentity(message, { userId } = {}) {
  const rawId = message.message_id || message.messageId || null;
  const canonicalMessageId = normalizeMessageId(rawId);
  // Physical copies of one RFC message can legitimately have different stored bodies
  // (provider-added wrappers, remote-image sanitization, All Mail vs Sent copies).  Body
  // content therefore cannot participate in the collision discriminator.  Keep the key
  // account-independent and based on stable RFC envelope evidence so copies held by two
  // managed accounts collapse into one LogicalMessage, while genuinely colliding IDs with
  // different sender/date/subject/reply evidence remain distinct.
  const stable = [
    userId || '', canonicalMessageId || '', message.date || '',
    canonicalConversationSubject(message.subject || ''),
    addressOf(message.from_email || message.from || message.sender) || '',
  ].join('\u001f');
  return { userId: userId || null, canonicalMessageId, rawMessageId: rawId, collisionKey: fingerprint(stable) };
}

export function threadingDecision({ message, parent, provider, identities = [] }) {
  const direction = classifyDirection(message, identities);
  const subject = canonicalConversationSubject(message.subject);
  if (provider?.isStrong && provider.providerThreadId) return { kind: 'provider_thread', reason: provider.source, confidence: 1, direction, subject };
  if (parent) {
    // An unambiguous RFC In-Reply-To/References edge is authoritative. Subjects
    // frequently change inside a real reply chain (ticket systems, edited reply
    // subjects, localized prefixes), so subject is diagnostic metadata only and
    // must never veto a strong parent edge.
    return {
      kind: 'human_reply_chain',
      reason: 'rfc-in-reply-to',
      confidence: 0.99,
      direction,
      subject,
      subjectChanged: canonicalConversationSubject(parent.subject) !== subject,
    };
  }
  return { kind: 'human_reply_chain', reason: 'new-root', confidence: 0.5, direction, subject };
}
