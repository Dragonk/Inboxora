import { createHash } from 'crypto';

const WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_SEGMENT = 100;
const GENERIC_SUBJECTS = new Set(['test', 'hello', 'hi', 'question', 'invoice', 'faktura', 'oferta', 'informacja', 'notification', 'powiadomienie', 'no subject', 'brak tematu']);

export function automationSignals(message = {}) {
  const headers = message.headers || message.parsedHeaders || {};
  const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase();
  const precedence = String(headers.precedence || '').toLowerCase();
  const sender = String(message.from_email || '').toLowerCase();
  return {
    automated: autoSubmitted === 'auto-generated' || autoSubmitted === 'auto-replied' || precedence === 'bulk' || precedence === 'list' || /(?:^|[+.-])no-?reply@/.test(sender),
    senderSignature: [sender, headers['return-path'] || '', headers['dkim-signature'] || '', headers['list-id'] || ''].join('|').toLowerCase(),
    recipientSignature: JSON.stringify((message.to_addresses || []).map(a => a.email || a).sort()),
  };
}

const OTP_TEMPLATE_RE = /(?:otp|one[- ]time|verification|security|code|kod|weryfik|passcode|hasło)/i;
const SMART_DENYLIST_RE = /(?:invoice|faktura|order|zamów|ticket|case|ref(?:erence)?|tracking|shipment|parcel|numer|id\b)/i;

export function bodyTemplateFingerprint(body = '') {
  const normalized = String(body).replace(/\b[0-9]{4,}\b/g, '{number}').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function strictSeriesDecision({ message, previous, mode = 'strict' }) {
  if (!previous || mode !== 'strict') return null;
  const now = new Date(message.received_at || message.date).getTime();
  const prior = new Date(previous.received_at || previous.date).getTime();
  const signals = automationSignals(message);
  const priorSignals = automationSignals(previous);
  const subject = String(message.canonical_subject || '').toLowerCase();
  if (!signals.automated || !priorSignals.automated || !subject || GENERIC_SUBJECTS.has(subject)) return null;
  if (signals.senderSignature !== priorSignals.senderSignature || signals.recipientSignature !== priorSignals.recipientSignature) return null;
  if (subject !== String(previous.canonical_subject || '').toLowerCase()) return null;
  if (now - prior > 7 * 24 * 60 * 60 * 1000 || now < prior) return null;
  if (!message.referencesAnchor || !previous.referencesAnchor || message.referencesAnchor !== previous.referencesAnchor) return null;
  if (Number(previous.logical_message_count || 0) >= MAX_SEGMENT) return { continuation: true };
  return { kind: 'automated_reference_series', confidence: 0.98, parentLogicalMessageId: null };
}

export function smartSeriesDecision({ message, previous, enabled = false }) {
  if (!enabled || !previous) return null;
  const now = new Date(message.received_at || message.date).getTime();
  const prior = new Date(previous.received_at || previous.date).getTime();
  const signals = automationSignals(message);
  const priorSignals = automationSignals(previous);
  if (!signals.automated || !priorSignals.automated || signals.senderSignature !== priorSignals.senderSignature || signals.recipientSignature !== priorSignals.recipientSignature) return null;
  const subject = String(message.canonical_subject || '');
  const body = String(message.body_text || '');
  if (!OTP_TEMPLATE_RE.test(subject + ' ' + body) || SMART_DENYLIST_RE.test(subject)) return null;
  if (now - prior > WINDOW_MS || now < prior || bodyTemplateFingerprint(message.body_text) !== bodyTemplateFingerprint(previous.body_text)) return null;
  if (Number(previous.logical_message_count || 0) >= MAX_SEGMENT) return { continuation: true };
  return { kind: 'automated_smart_series', confidence: 0.9, parentLogicalMessageId: null };
}
