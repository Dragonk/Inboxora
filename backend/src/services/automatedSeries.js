import { createHash } from 'crypto';

const WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_SEGMENT = 100;
const GENERIC_SUBJECTS = new Set(['test', 'hello', 'hi', 'question', 'invoice', 'faktura', 'oferta', 'informacja', 'notification', 'powiadomienie', 'no subject', 'brak tematu']);

export function automationSignals(message = {}) {
  const headers = message.headers || message.parsedHeaders || {};
  const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase();
  const precedence = String(headers.precedence || '').toLowerCase();
  const sender = String(message.from_email || '').toLowerCase();

  // P1-14: Authenticated sender evidence — DKIM/SPF/DMARC results from
  // parsed headers. These are NOT self-declared; they are verified by the
  // receiving MTA and recorded in Authentication-Results or ARC headers.
  // Self-declared headers (Auto-Submitted, Precedence, no-reply) are hints
  // but NOT cryptographically authenticated evidence.
  const authResults = String(headers['authentication-results'] || headers['arc-authentication-results'] || '').toLowerCase();
  const dkimPass = /dkim=pass/.test(authResults);
  const spfPass = /spf=pass/.test(authResults);
  const dmarcPass = /dmarc=pass/.test(authResults);
  const hasAuthEvidence = dkimPass || spfPass || dmarcPass;

  return {
    // `automated` is a hint — used for candidate filtering, NOT for STRICT
    // merge approval. STRICT requires authenticatedSenderEvidence below.
    automated: autoSubmitted === 'auto-generated' || autoSubmitted === 'auto-replied' || precedence === 'bulk' || precedence === 'list' || /(?:^|[+.-])no-?reply@/.test(sender),
    // P1-14: Authenticated sender evidence — required for STRICT merge.
    // Without DKIM/SPF/DMARC pass, STRICT does not approve the merge.
    authenticatedSenderEvidence: hasAuthEvidence,
    dkimPass, spfPass, dmarcPass,
    // DKIM-Signature is per-message (its signature/timestamp changes for every
    // delivery), so it is evidence that auth passed but must not be part of the
    // stable sender identity used to compare two series messages.
    senderSignature: [sender, headers['return-path'] || '', headers['list-id'] || ''].join('|').toLowerCase(),
    recipientSignature: JSON.stringify((message.to_addresses || []).map(a => a.email || a).sort()),
  };
}

const OTP_TEMPLATE_RE = /(?:otp|one[- ]time|verification|security|code|kod|weryfik|passcode|hasło)/i;
const IDENTIFIER_KEYWORDS = /(?:order|zamów|ticket|case|ref(?:erence)?|tracking|shipment|parcel|invoice|faktura|numer|id)\b/i;

/**
 * Conservative body template fingerprint for smart-series OTP matching.
 *
 * P1-04: the previous implementation globally replaced ALL 4+ digit
 * sequences with '{number}', which destroyed ticket/order/invoice/tracking
 * IDs. Two messages with different order numbers would incorrectly match.
 *
 * The new approach: only normalize variable OTP/verification codes —
 * short standalone numeric sequences (4-8 digits) that are NOT attached to
 * an identifier keyword. Sequences preceded by identifier keywords
 * (order, ticket, invoice, tracking, etc.) are PRESERVED so that
 * Order #123456 and Order #987654 produce different fingerprints.
 */
export function bodyTemplateFingerprint(body = '') {
  const text = String(body);
  // Split into tokens and selectively mask only standalone numbers that
  // are NOT preceded by an identifier keyword.
  const tokens = text.split(/(\s+|[,;:(){}[\]<>])/);
  let prevSignificant = '';
  const masked = tokens.map(token => {
    // If this token is a 4-8 digit number and the previous significant
    // token is NOT an identifier keyword, mask it as {otp}.
    if (/^[0-9]{4,8}$/.test(token) && !IDENTIFIER_KEYWORDS.test(prevSignificant)) {
      return '{otp}';
    }
    if (token.trim() && !/^[\s,;:(){}[\]<>]+$/.test(token)) {
      prevSignificant = token;
    }
    return token;
  }).join('');
  return createHash('sha256').update(masked.replace(/\s+/g, ' ').trim()).digest('hex');
}

export function strictSeriesDecision({ message, previous, mode = 'strict' }) {
  if (!previous || mode !== 'strict') return null;
  const now = new Date(message.received_at || message.date).getTime();
  const prior = new Date(previous.received_at || previous.date).getTime();
  const signals = automationSignals(message);
  const priorSignals = automationSignals(previous);
  const subject = String(message.canonical_subject || '').toLowerCase();
  if (!subject || GENERIC_SUBJECTS.has(subject)) return null;
  // P1-14: STRICT MUST require authenticated sender evidence (DKIM/SPF/DMARC).
  // Self-declared Auto-Submitted/Precedence/no-reply are NOT sufficient.
  // Both message AND previous must have auth evidence.
  if (!signals.authenticatedSenderEvidence || !priorSignals.authenticatedSenderEvidence) return null;
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
  // P1-04: no longer denylist by subject keyword — the conservative fingerprint
  // preserves identifier-attached numbers, so Order #123456 vs Order #987654
  // produce different fingerprints and will NOT match. OTP-like short codes
  // are still normalized so variable verification codes DO match.
  if (!OTP_TEMPLATE_RE.test(subject + ' ' + body)) return null;
  if (now - prior > WINDOW_MS || now < prior || bodyTemplateFingerprint(message.body_text) !== bodyTemplateFingerprint(previous.body_text)) return null;
  if (Number(previous.logical_message_count || 0) >= MAX_SEGMENT) return { continuation: true };
  return { kind: 'automated_smart_series', confidence: 0.9, parentLogicalMessageId: null };
}
