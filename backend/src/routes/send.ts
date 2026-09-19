import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { Readable } from 'node:stream';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { redisClient } from '../services/redis.js';
import { redactEmail } from '../utils/redact.js';
import type { EmailAccountRow } from '../services/imapManager.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { generateVCard } from '../utils/vcard.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { toAppError } from '../utils/errors.js';
import { resolveSenderIdentity } from '../services/senderIdentity.js';
import { resolveIncomingBodyIsHtml, resolveOutgoingBodyIsHtml } from '../services/composeFormat.js';
import type { InlineAttachment } from '../utils/inlineImages.js';

/** One client-supplied attachment of an outgoing message (base64 payload). */
interface ComposerAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

/** One client-supplied reference to an attachment stored on a synced message. */
interface ForwardedAttachmentRef {
  messageId: string;
  part: string;
}

/** A single attachment entry as persisted in messages.attachments (jsonb or JSON text). */
interface StoredAttachment {
  part: string;
  filename?: string | null;
  type?: string | null;
  size?: number | string | null;
}

/** The columns selected from messages when resolving forwarded attachments. */
interface ForwardedMessageRow {
  id: string;
  uid: number;
  folder: string;
  attachments: string | StoredAttachment[] | null;
  account_id: string;
}

/** A forwarded attachment whose bytes were fetched over IMAP. */
interface ResolvedForwardedAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** The POST /send JSON payload after the request body is destructured. */
interface SendRequestBody {
  accountId?: string;
  aliasId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: unknown;
  bodyIsHtml?: boolean;
  quotedBody?: string;
  quotedBodyHtml?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: ComposerAttachment[];
  editedSignature?: string;
  editedSignatureIsHtml?: boolean;
  forwardedAttachments?: ForwardedAttachmentRef[];
  priority?: string;
}

type EmailPriority = 'high' | 'normal' | 'low';

function isEmailPriority(value: unknown): value is EmailPriority {
  return value === 'high' || value === 'normal' || value === 'low';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Map SMTP/connection errors to user-friendly messages that don't expose server internals.
function sanitizeSmtpError(err: unknown): string {
  const msg = toAppError(err).message || '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (/535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username/i.test(msg)) {
    return 'Authentication failed. Check your email account credentials.';
  }
  if (/throttl|rate.?limit|too many|4\.2\.|4\.7\.94/i.test(msg)) {
    return 'The mail server is rate limiting sends. Please try again shortly.';
  }
  if (/550|5\.[13]\.|reject|blacklist|spam|not.?accept/i.test(msg)) {
    return 'Message was rejected by the mail server.';
  }
  if (/TLS|SSL|certificate|handshake/i.test(msg)) {
    return 'Secure connection to the mail server failed. Check your TLS settings.';
  }
  return 'Failed to send message. Please try again.';
}

// Extract name and email from an RFC 5322 address string.
// Handles "Name <email>", "Name<email>", bare "<email>", and bare "email" forms.
function parseAddress(str: string) {
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}

function mapRecipientList(list: unknown): Array<{ name: string; email: string }> {
  return (Array.isArray(list) ? list : []).map((addr: unknown) => parseAddress(String(addr ?? '')));
}

function buildSentSnippet(body: unknown, bodyIsHtml: boolean): string {
  return bodyToPlain(body, bodyIsHtml).replace(/\s+/g, ' ').trim().substring(0, 200);
}

// OAuth providers are expected to add a Sent copy themselves, but that is a
// provider behaviour rather than an SMTP guarantee. Verify it by the stable
// Message-ID, then append the exact CRLF MIME message once if it never appears.
// The fallback is deliberately not retried: IMAP APPEND is not idempotent and a
// timed-out first APPEND might still have reached the server.
interface SentCopyLookupResult {
  state: 'found' | 'missing' | 'ambiguous';
  uid?: number | null;
}

/** The narrow slice of the IMAP manager this recovery path depends on. */
export interface SentCopyManager {
  findSentMessageByMessageId(account: unknown, folder: string, messageId: string): Promise<SentCopyLookupResult>;
  appendToSent(account: unknown, folder: string, rawMessage: Buffer): Promise<{ uid?: number | null }>;
  upsertSentMessageRecord(account: unknown, folder: string, uid: number | null | undefined, sentMeta: unknown): Promise<unknown>;
}

interface EnsureServerAutoSavedSentCopyInput {
  account: { id?: string; email_address?: string };
  sentFolder: string;
  messageId: string;
  rawMessage: Buffer;
  sentMeta?: unknown;
  manager?: SentCopyManager;
  delays?: number[];
  sleep?: (delay: number) => Promise<unknown>;
}

export async function ensureServerAutoSavedSentCopy({
  account,
  sentFolder,
  messageId,
  rawMessage,
  sentMeta,
  manager = imapManager,
  delays = [3000, 10000, 20000],
  sleep = (delay) => new Promise(resolve => setTimeout(resolve, delay)),
}: EnsureServerAutoSavedSentCopyInput) {
  if (!sentFolder || !messageId || !rawMessage) return { saved: false, appended: false };

  let verificationFailed = false;
  for (const delay of delays) {
    await sleep(delay);
    try {
      const result = await manager.findSentMessageByMessageId(account, sentFolder, messageId);
      if (result.state === 'found') {
        if (sentMeta) await manager.upsertSentMessageRecord(account, sentFolder, result.uid, sentMeta);
        return { saved: true, appended: false };
      }
      if (result.state === 'ambiguous') verificationFailed = true;
    } catch (caught) {
      const err = toAppError(caught);
      verificationFailed = true;
      console.warn('Post-send Sent-copy verification failed:', err.message);
    }
  }

  // An IMAP error means "unknown", not "absent". APPEND only after every
  // lookup completed and confirmed absence, otherwise a late provider copy
  // could be duplicated when connectivity recovers.
  if (verificationFailed) return { saved: false, appended: false };

  // Close the practical gap after the delayed observations: a provider can
  // materialize its Sent copy just after the final timer fires. This cannot be
  // made fully atomic across independent SMTP and IMAP servers, but it prevents
  // the ordinary late-visibility race without ever appending on uncertainty.
  try {
    const finalResult = await manager.findSentMessageByMessageId(account, sentFolder, messageId);
    if (finalResult.state === 'found') {
      if (sentMeta) await manager.upsertSentMessageRecord(account, sentFolder, finalResult.uid, sentMeta);
      return { saved: true, appended: false };
    }
    if (finalResult.state !== 'missing') return { saved: false, appended: false };
  } catch (caught) {
    const err = toAppError(caught);
    console.warn('Post-send final Sent-copy verification failed:', err.message);
    return { saved: false, appended: false };
  }

  try {
    const { uid } = await manager.appendToSent(account, sentFolder, rawMessage);
    if (uid && sentMeta) await manager.upsertSentMessageRecord(account, sentFolder, uid, sentMeta);
    return { saved: true, appended: true };
  } catch (caught) {
    const err = toAppError(caught);
    console.error(`Post-send Sent-copy fallback APPEND failed for ${redactEmail(account.email_address || '')}/${sentFolder}: ${err.message}`);
    return { saved: false, appended: true };
  }
}

// Reject any recipient address that contains newlines, null bytes, or looks
// malformed — these are the classic email header-injection vectors.
function normalizeRecipients(list: unknown, fieldName: string): string[] {
  if (!Array.isArray(list)) throw Object.assign(new Error(`${fieldName} must be an array`), { status: 400 });
  return list.map((addr, i) => {
    if (typeof addr !== 'string' || !addr.trim()) {
      throw Object.assign(new Error(`${fieldName}[${i}] is empty or not a string`), { status: 400 });
    }
    const trimmed = addr.trim();
    if (/[\r\n\0]/.test(trimmed)) {
      throw Object.assign(new Error(`${fieldName}[${i}] contains invalid characters`), { status: 400 });
    }
    const at = trimmed.lastIndexOf('@');
    if (at < 1 || at === trimmed.length - 1) {
      throw Object.assign(new Error(`${fieldName}[${i}] is not a valid email address`), { status: 400 });
    }
    return trimmed;
  });
}

// Strip header-injection characters from single-line header values.
function sanitizeHeaderValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

function textToHtml(text: string) {
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    text.split('\n').map(l => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('') +
    '</div>';
}

function sigToPlainText(html: string) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

function bodyToPlain(body: unknown, isHtml: boolean): string {
  if (!isHtml) return String(body ?? '');
  return sanitizeHtml(String(body ?? ''), { allowedTags: [], allowedAttributes: {} });
}

function bodyToHtml(body: unknown, isHtml: boolean): string {
  const text = String(body ?? '');
  if (!isHtml) return textToHtml(text);
  return sanitizeComposeBody(text);
}

const IDEMPOTENCY_LEASE_SECONDS = 300;
const IDEMPOTENCY_RENEW_MS = 60_000;
const INFLIGHT_PREFIX = '__inflight__:';

// Redis is only a fast path for replaying completed responses and coordinating the
// live lease. The database intent below is authoritative: it survives Redis loss,
// process restarts, and requests that were still preparing their MIME message when a
// different request lost its lease.
type SendIntentRow = {
  status: 'pending' | 'uncertain' | 'completed';
  request_fingerprint: string;
  result: unknown;
};

type SendIntentClaim =
  | { state: 'claimed' }
  | { state: 'inflight' | 'uncertain' }
  | { state: 'completed'; result: unknown }
  | { state: 'mismatch' };

async function claimSendIntent(userId: string, idempotencyKey: string, fingerprint: string, compatibleFingerprints: readonly string[], token: string): Promise<SendIntentClaim> {
  const inserted = await query<SendIntentRow>(
    `INSERT INTO send_idempotency (user_id, idempotency_key, request_fingerprint, status, intent_token)
     VALUES ($1, $2, $3, 'pending', $4::uuid)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING status`,
    [userId, idempotencyKey, fingerprint, token],
  );
  if (inserted.rows.length) return { state: 'claimed' };

  const existing = await query<SendIntentRow>(
    `SELECT status, request_fingerprint, result
     FROM send_idempotency WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  const row = existing.rows[0];
  // A pre-send failure may have released the row between the INSERT conflict and
  // SELECT. Fail closed; the client can safely make a fresh request.
  if (!row) return { state: 'inflight' };
  if (!compatibleFingerprints.includes(row.request_fingerprint)) return { state: 'mismatch' };
  if (row.status === 'completed') return { state: 'completed', result: row.result };
  return { state: row.status === 'uncertain' ? 'uncertain' : 'inflight' };
}

async function markSendIntentUncertain(userId: string, idempotencyKey: string, token: string) {
  return query(
    `UPDATE send_idempotency SET status = 'uncertain', updated_at = NOW()
     WHERE user_id = $1 AND idempotency_key = $2 AND intent_token = $3::uuid AND status = 'pending'`,
    [userId, idempotencyKey, token],
  );
}

async function completeSendIntent(userId: string, idempotencyKey: string, token: string, result: unknown) {
  return query(
    `UPDATE send_idempotency SET status = 'completed', result = $4::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND idempotency_key = $2 AND intent_token = $3::uuid
       AND status IN ('pending', 'uncertain')`,
    [userId, idempotencyKey, token, JSON.stringify(result)],
  );
}

async function releaseSendIntent(userId: string, idempotencyKey: string, token: string) {
  return query(
    `DELETE FROM send_idempotency
     WHERE user_id = $1 AND idempotency_key = $2 AND intent_token = $3::uuid`,
    [userId, idempotencyKey, token],
  );
}

interface CachedSendResult {
  version: 1;
  fingerprint: string;
  result: unknown;
}

function parseCachedSendResult(value: string): CachedSendResult | null {
  try {
    const parsed = JSON.parse(value) as Partial<CachedSendResult>;
    if (parsed?.version === 1 && typeof parsed.fingerprint === 'string' && 'result' in parsed) {
      return parsed as CachedSendResult;
    }
  } catch { /* A malformed or legacy cache value must fall back to PostgreSQL. */ }
  return null;
}

function isExplicitSmtpRejection(error: unknown): boolean {
  const candidate = error as { responseCode?: unknown };
  const responseCode = Number(candidate?.responseCode);
  // responseCode is nodemailer's structured SMTP reply. A reply in either error
  // class is a known rejection, including a temporary DATA/STARTTLS rejection.
  // Do not infer this from message text: a connection loss can contain a stale
  // 5xx-looking transcript after DATA was already accepted.
  return Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600;
}

function isDefinitelyPreDeliveryFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate?.code || '');
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAUTH'].includes(code)
    || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|authentication failed/i.test(String(candidate?.message || ''));
}

function retainedLease(result: unknown): boolean {
  return result === 1 || result === 'OK';
}

async function renewIdempotencyLease(key: string, token: string) {
  return redisClient.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0",
    { keys: [key], arguments: [token, String(IDEMPOTENCY_LEASE_SECONDS)] },
  );
}

async function releaseIdempotencyLease(key: string, token: string) {
  return redisClient.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    { keys: [key], arguments: [token] },
  );
}

async function completeIdempotencyLease(key: string, token: string, result: unknown) {
  return redisClient.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return 0",
    { keys: [key], arguments: [token, JSON.stringify(result), '86400'] },
  );
}

const router = Router();
router.use(requireAuth);


router.post('/send', async (req, res) => {
  const { accountId, aliasId, to, cc = [], bcc = [], subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, inReplyTo, references, attachments, editedSignature, editedSignatureIsHtml, forwardedAttachments, priority }: SendRequestBody = req.body;
  const emailPriority = isEmailPriority(priority) ? priority : 'normal';
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  if (bodyIsHtml !== undefined && typeof bodyIsHtml !== 'boolean') return res.status(400).json({ error: 'bodyIsHtml must be a boolean' });
  if (editedSignatureIsHtml !== undefined && typeof editedSignatureIsHtml !== 'boolean') return res.status(400).json({ error: 'editedSignatureIsHtml must be a boolean' });

  // Idempotency guard. The client sends a stable X-Idempotency-Key per logical send: a
  // sequential retry after a lost success response returns the cached result, and a
  // concurrent same-key submit is blocked by the reservation set just before delivery
  // (below). Neither can produce a duplicate email.
  const idempotencyKey = typeof req.headers['x-idempotency-key'] === 'string'
    ? req.headers['x-idempotency-key'].slice(0, 128)
    : null;
  const idemKeyRedis = idempotencyKey ? `send_idem:${req.session.userId!}:${idempotencyKey}` : null;

  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return res.status(400).json({ error: 'attachments must be an array' });
    if (attachments.length > 100) return res.status(400).json({ error: 'Too many attachments (max 100)' });
    const totalBytes = attachments.reduce((sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0);
    if (totalBytes > 26_214_400) {
      // §22.1 maps content that is too large to 413 with a domain code; this guard is the oldest of the size
      // checks and reported neither, so a client had to match English prose to know what happened.
      return res.status(413).json({ code: 'ATTACHMENT_TOO_LARGE', actual: totalBytes, limit: 26_214_400, error: 'Total attachment size exceeds 25 MB' });
    }
    for (const [i, a] of attachments.entries()) {
      if (typeof a.filename !== 'string' || !a.filename.trim()) return res.status(400).json({ error: `attachments[${i}].filename is required` });
      if (typeof a.content !== 'string') return res.status(400).json({ error: `attachments[${i}].content must be a base64 string` });
    }
  }

  if (forwardedAttachments !== undefined) {
    if (!Array.isArray(forwardedAttachments)) return res.status(400).json({ error: 'forwardedAttachments must be an array' });
    if (forwardedAttachments.length > 100) return res.status(400).json({ error: 'Too many forwarded attachments (max 100)' });
    for (const [i, fa] of forwardedAttachments.entries()) {
      if (typeof fa.messageId !== 'string' || !UUID_RE.test(fa.messageId)) return res.status(400).json({ error: `forwardedAttachments[${i}].messageId is invalid` });
      if (typeof fa.part !== 'string' || !fa.part.trim()) return res.status(400).json({ error: `forwardedAttachments[${i}].part is required` });
    }
  }

  let normalizedTo, normalizedCc, normalizedBcc;
  try {
    normalizedTo  = normalizeRecipients(to ?? [],  'to');
    normalizedCc  = normalizeRecipients(cc ?? [],  'cc');
    normalizedBcc = normalizeRecipients(bcc ?? [], 'bcc');
  } catch (caught) {
    const err = toAppError(caught);
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (!normalizedTo.length && !normalizedCc.length && !normalizedBcc.length) {
    return res.status(400).json({ error: 'At least one recipient is required' });
  }
  const normalizedSubject = sanitizeHeaderValue(subject || '');

  const [result, prefResult] = await Promise.all([
    query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId!]),
    query<{ preferences?: { plaintextEmail?: boolean; [key: string]: unknown } | null }>('SELECT preferences FROM users WHERE id = $1', [req.session.userId!]),
  ]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;
  // Omitted legacy fields were always literal text input. The profile may select
  // an additional HTML MIME representation, but must never reinterpret that input.
  const inputBodyIsHtml = resolveIncomingBodyIsHtml(bodyIsHtml);
  const outputBodyIsHtml = resolveOutgoingBodyIsHtml(bodyIsHtml, plaintextEmail);
  let account = result.rows[0];
  let sender;
  try {
    sender = await resolveSenderIdentity(account, aliasId);
  } catch (caught) {
    const err = toAppError(caught);
    return res.status(err.status || 400).json({ error: err.message });
  }
  const { fromName, fromEmail, fromReplyTo, fromSignature } = sender;

  // Allow the client to override the signature per-send (editedSignature === undefined means use DB value).
  // Sanitize client-supplied HTML to prevent injecting scripts or tracking pixels into sent mail.
  const signatureIsHtml = editedSignatureIsHtml !== false;
  const effectiveSignature = editedSignature !== undefined
    ? (editedSignature ? (signatureIsHtml ? sanitizeSignature(editedSignature) : textToHtml(editedSignature)) : null)
    : fromSignature;  // fromSignature from DB is already sanitized on write
  const effectiveSignatureText = editedSignature !== undefined && !signatureIsHtml
    ? editedSignature
    : (effectiveSignature ? sigToPlainText(effectiveSignature) : null);

  // Fetch forwarded attachment content from IMAP before entering the SMTP try-block so that
  // attachment errors return descriptive messages rather than being sanitized as SMTP errors.
  let resolvedFwdAttachments: ResolvedForwardedAttachment[] = [];
  if (forwardedAttachments?.length) {
    try {
      // Resolve every referenced message in a SINGLE ownership-scoped query so a large
      // forwardedAttachments array can't fan out into one DB round-trip per entry.
      const distinctMsgIds = [...new Set(forwardedAttachments.map(fa => fa.messageId))];
      const msgRows = await query<ForwardedMessageRow>(
        `SELECT m.id, m.uid, m.folder, m.attachments, m.account_id FROM messages m
         JOIN email_accounts a ON m.account_id = a.id
         WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2`,
        [distinctMsgIds, req.session.userId!]
      );
      const msgById = new Map<string, ForwardedMessageRow>(msgRows.rows.map(m => [m.id, m]));

      // Build the fetch plan (one entry per requested attachment, order preserved) and sum the
      // DECLARED sizes so an oversized batch is rejected BEFORE any IMAP fetch happens.
      const uploadedBytes = (attachments || []).reduce(
        (sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0
      );
      let declaredFwdBytes = 0;
      const fetchPlan = forwardedAttachments.map((fa) => {
        const msg = msgById.get(fa.messageId);
        if (!msg) throw Object.assign(new Error('Forwarded message not found'), { status: 404, code: 'RESOURCE_NOT_FOUND' });
        const storedAtts: StoredAttachment[] = typeof msg.attachments === 'string'
          ? JSON.parse(msg.attachments || '[]')
          : (msg.attachments || []);
        const att = storedAtts.find(a => a.part === fa.part);
        if (!att) throw Object.assign(new Error('Attachment not found in message'), { status: 404, code: 'RESOURCE_NOT_FOUND' });
        declaredFwdBytes += Number(att.size) || 0;
        return { msg, att };
      });
      if (uploadedBytes + declaredFwdBytes > 26_214_400) {
        return res.status(413).json({ code: 'MESSAGE_TOO_LARGE', actual: uploadedBytes + declaredFwdBytes, limit: 26_214_400, error: 'Total attachment size exceeds 25 MB' });
      }

      // Load the owning accounts once, then fetch bodies with bounded concurrency so we never
      // open a burst of fresh IMAP connections (fetchAttachment opens a connection per call).
      const distinctAcctIds = [...new Set(fetchPlan.map(p => p.msg.account_id))];
      const acctRows = await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [distinctAcctIds]);
      const acctById = new Map<string, EmailAccountRow>(acctRows.rows.map(a => [a.id, a]));

      const FWD_FETCH_CONCURRENCY = 4;
      for (let i = 0; i < fetchPlan.length; i += FWD_FETCH_CONCURRENCY) {
        const batch = fetchPlan.slice(i, i + FWD_FETCH_CONCURRENCY);
        const fetched = await Promise.all(batch.map(async ({ msg, att }) => {
          const acct = acctById.get(msg.account_id);
          if (!acct) throw Object.assign(new Error('Account not found'), { status: 404, code: 'RESOURCE_NOT_FOUND' });
          const buffer = await imapManager.fetchAttachment(acct, msg.uid, msg.folder, att.part);
          if (!buffer) // §22.1 names this outcome, and its rule is §12.9's sentence: a retry of the read is possible, and the
            // message is not sent without the file.
            throw Object.assign(new Error(`Could not fetch attachment: ${att.filename}`), { status: 502, code: 'ATTACHMENT_FETCH_FAILED' });
          return {
            filename: sanitizeHeaderValue(att.filename || 'attachment'),
            content: buffer,
            contentType: att.type || 'application/octet-stream',
          };
        }));
        resolvedFwdAttachments.push(...fetched);
      }

      // Exact backstop: declared sizes can under-report, so re-check against fetched bytes.
      const fwdBytes = resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
      if (uploadedBytes + fwdBytes > 26_214_400) {
        return res.status(400).json({ error: 'Total attachment size exceeds 25 MB' });
      }
    } catch (caught) {
      const err = toAppError(caught);
      // Carry the domain code through, so the interface can answer in the user's language instead of echoing
      // this sentence — the same reason the uncertainty and size refusals gained codes.
      const failure = err as Error & { status?: number; code?: string };
      return res.status(failure.status || 500).json({
        ...(failure.code ? { code: failure.code } : {}),
        error: failure.message || 'Failed to fetch forwarded attachments',
      });
    }
  }

  let reservationAcquired = false;
  let reservationToken: string | null = null;
  let intentToken: string | null = null;
  let intentClaimed = false;
  const sendFingerprint = createHash('sha256').update(JSON.stringify({
    accountId, aliasId: aliasId || null, to: normalizedTo, cc: normalizedCc, bcc: normalizedBcc,
    subject: normalizedSubject, body, inputBodyIsHtml, outputBodyIsHtml, quotedBody, quotedBodyHtml, inReplyTo, references,
    attachments, forwardedAttachments, editedSignature,
    editedSignatureIsHtml: editedSignature === undefined ? null : editedSignatureIsHtml !== false,
    priority: emailPriority,
  })).digest('hex');
  // V1 used the raw API field (defaulting to false). Keep this recognisable
  // during upgrades so a lost response cannot turn into a new delivery.
  const legacyFingerprint = createHash('sha256').update(JSON.stringify({
    accountId, aliasId: aliasId || null, to: normalizedTo, cc: normalizedCc, bcc: normalizedBcc,
    subject: normalizedSubject, body, bodyIsHtml: bodyIsHtml ?? false, quotedBody, quotedBodyHtml, inReplyTo, references,
    attachments, forwardedAttachments, editedSignature, priority: emailPriority,
  })).digest('hex');
  // Only requests without the newer signature-format contract may match V1.
  // Otherwise a changed signature interpretation must conflict, not replay.
  const compatibleFingerprints = [sendFingerprint];
  // d7f514c3 used the two body-format flags but had no signature-format field.
  // It is unambiguous only when no signature override was supplied.
  if (editedSignature === undefined) {
    const priorTwoFormatFingerprint = createHash('sha256').update(JSON.stringify({
      accountId, aliasId: aliasId || null, to: normalizedTo, cc: normalizedCc, bcc: normalizedBcc,
      subject: normalizedSubject, body, inputBodyIsHtml, outputBodyIsHtml, quotedBody, quotedBodyHtml, inReplyTo, references,
      attachments, forwardedAttachments, editedSignature, priority: emailPriority,
    })).digest('hex');
    compatibleFingerprints.push(priorTwoFormatFingerprint);
  }
  if (editedSignatureIsHtml === undefined) compatibleFingerprints.push(legacyFingerprint);
  // 2b3d927e also used its profile-derived output flag as bodyIsHtml when the
  // field was omitted. Recognise that precise historical form, never broadly.
  if (bodyIsHtml === undefined && editedSignatureIsHtml === undefined) {
    const historicalFingerprint = createHash('sha256').update(JSON.stringify({
      accountId, aliasId: aliasId || null, to: normalizedTo, cc: normalizedCc, bcc: normalizedBcc,
      subject: normalizedSubject, body, bodyIsHtml: outputBodyIsHtml, quotedBody, quotedBodyHtml, inReplyTo, references,
      attachments, forwardedAttachments, editedSignature, priority: emailPriority,
    })).digest('hex');
    compatibleFingerprints.push(historicalFingerprint);
  }
  if (idemKeyRedis) {
    let cached: string | null;
    try { cached = await redisClient.get(idemKeyRedis); }
    catch { return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' }); }
    if (cached?.startsWith(INFLIGHT_PREFIX)) return res.status(409).json({ error: 'This message is already being sent.' });
    if (cached) {
      const replay = parseCachedSendResult(cached);
      if (replay) {
        if (!compatibleFingerprints.includes(replay.fingerprint)) {
          return res.status(409).json({ error: 'This idempotency key belongs to a different message.' });
        }
        return res.json(replay.result);
      }
      // Legacy cache entries have no canonical request identity. Ignore them and
      // obtain the authoritative result (or mismatch) from the durable intent.
    }
  }
  let reservationRenewal: ReturnType<typeof setInterval> | null = null;
  const stopReservationRenewal = () => {
    if (reservationRenewal) clearInterval(reservationRenewal);
    reservationRenewal = null;
  };
  let delivered = false; // true once transport.sendMail has actually handed off the message
  let smtpDispatchStarted = false;
  let finalizationStarted = false;
  let smtpRecipients: { accepted: string[]; rejected: string[] } | null = null;
  const markLeaseUncertain = (fromRenewal = false) => {
    // A renewal response can arrive after finalization has begun. It no longer
    // owns the lease and must not overwrite a completed-result reconciliation.
    if (fromRenewal && finalizationStarted) return;
    if (idempotencyKey && intentToken) {
      void markSendIntentUncertain(req.session.userId!, idempotencyKey!, intentToken!).catch(() => {});
    }
  };
  try {
    const smtp = await createAccountSmtpTransport(account);
    if (smtp.error) return res.status(smtp.status).json({ error: smtp.error });
    if (!smtp.transport) throw new Error('SMTP transport is unavailable');
    account = smtp.account;
    const transport = smtp.transport;

    // Use a stable Message-ID so the SMTP copy and any IMAP APPEND reference the same message.
    const domain = (fromEmail || '').split('@')[1] || 'mailflow.local';
    const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;
    const mailOptions: SendMailOptions = {
      messageId,
      from: `${fromName} <${fromEmail}>`,
      ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
      // Nodemailer uses bcc for the SMTP envelope but omits it from generated MIME.
      // Do not add a synthetic To header for BCC-only retries.
      ...(normalizedTo.length ? { to: normalizedTo.join(', ') } : {}),
      ...(normalizedCc.length ? { cc: normalizedCc.join(', ') } : {}),
      ...(normalizedBcc.length ? { bcc: normalizedBcc.join(', ') } : {}),
      subject: normalizedSubject,
      ...(emailPriority !== 'normal' ? { priority: emailPriority } : {}),
      text: effectiveSignature
        ? bodyToPlain(body, inputBodyIsHtml) + '\n\n-- \n' + effectiveSignatureText + (quotedBody || '')
        : bodyToPlain(body, inputBodyIsHtml) + (quotedBody || ''),
    };

    let inlineImageAttachments: InlineAttachment[] = [];
    if (outputBodyIsHtml) {
      const rawHtml = bodyToHtml(body, inputBodyIsHtml) +
        (effectiveSignature
          ? '<div style="margin-top:16px;color:#555;font-size:13px">' + effectiveSignature + '</div>'
          : '') +
        (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
      const embedded = embedInlineDataImages(rawHtml);
      mailOptions.html = embedded.html;
      inlineImageAttachments = embedded.attachments;
    }

    if (inReplyTo) {
      mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
    }
    // References is valid and useful even when In-Reply-To is absent. Preserve
    // the complete ordered chain independently so RFC-only References replies
    // remain attached to the existing Conversation after Sent ingest.
    if (references || inReplyTo) {
      mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
    }
    const allAttachments = [
      ...inlineImageAttachments,
      ...(attachments?.length ? attachments.map(a => ({
        filename: sanitizeHeaderValue(a.filename),
        content: Buffer.from(a.content, 'base64'),
        contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
      })) : []),
      ...resolvedFwdAttachments,
    ];
    if (allAttachments.length) {
      mailOptions.attachments = allAttachments;
    }

    // §22.1 wants an oversized attachment named rather than only totalled, and §12.2 requires the real bytes
    // rather than a declared size: these contents are the decoded ones, so this is measurement, not trust. The
    // total check below would refuse the same message, which is why this runs first — same policy, but the
    // administrator learns which file caused it.
    const perAttachmentLimit = mailMaxMessageBytes();
    const oversizedAttachment = allAttachments.find(
      a => Buffer.isBuffer(a.content) && a.content.length > perAttachmentLimit,
    );
    if (oversizedAttachment) {
      return res.status(413).json({
        code: 'ATTACHMENT_TOO_LARGE',
        actual: (oversizedAttachment.content as Buffer).length,
        limit: perAttachmentLimit,
        filename: oversizedAttachment.filename,
        error: `The attachment "${oversizedAttachment.filename}" is ${(oversizedAttachment.content as Buffer).length} bytes, above this installation's limit of ${perAttachmentLimit}.`,
      });
    }

    // OAuth providers (Gmail, Microsoft) save sent mail to IMAP automatically via their
    // servers — skip APPEND and sync after a delay.  All other accounts use direct IMAP
    // APPEND so sent mail reliably appears regardless of what the SMTP server does.
    // Gmail may server-save Sent even when authenticated with an app password;
    // OAuth configuration alone is not a reliable capability signal. Gmail's
    // provider policy therefore avoids a second local APPEND and relies on the
    // bounded metadata/search re-observation path below.
    const serverAutoSaves = !!account.oauth_provider || /gmail/i.test(account.imap_host || account.smtp_host || '');

    // Generate CRLF MIME now. Non-auto-saving servers use it immediately; the
    // auto-save path retains it for a verified fallback when the provider fails
    // to materialize a Sent copy.
    // Use CRLF newlines ('windows'): RFC 5322 / IMAP APPEND require CRLF. A bare-LF message is
    // stored verbatim by strict servers (e.g. PurelyMail/Dovecot), and downstream clients then
    // mis-parse the headers — the reporter saw Subject and the To display-name dropped (#365). This
    // delivered copy uses a separate transport that is already CRLF, so only the Sent copy was wrong.
    const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
    const streamInfo = await streamTransport.sendMail(mailOptions);
    const chunks: Buffer[] = [];
    const messageStream = streamInfo.message;
    if (!(messageStream instanceof Readable)) {
      throw new Error('Stream transport did not return a readable message');
    }
    await new Promise<void>((resolve, reject) => {
      messageStream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      messageStream.on('end', resolve);
      messageStream.on('error', reject);
    });
    const rawMessage = Buffer.concat(chunks);

    // §12.2: the interface's estimate is preliminary, and this is the message as actually compiled — headers,
    // base64 growth, separators and CRLF included — counted on the server side, before any dispatch. Nothing has
    // been claimed or handed to SMTP at this point, so refusing here leaves no uncertain send behind.
    const messageLimit = mailMaxMessageBytes();
    if (rawMessage.length > messageLimit) {
      // §12.2 counts three figures, not one: the raw attachment bytes, the compiled MIME, and the transport
      // encoding. The first two are known here, and naming the attachment subtotal tells the user whether to
      // remove a file or shorten the message — the difference between advice and a number.
      const rawAttachmentBytes = allAttachments.reduce(
        (sum, a) => sum + (Buffer.isBuffer(a.content) ? a.content.length : 0), 0,
      );
      return res.status(413).json({
        code: 'MESSAGE_TOO_LARGE',
        actual: rawMessage.length,
        limit: messageLimit,
        error: `The composed message is ${rawMessage.length} bytes, above this installation's limit of ${messageLimit}.`
          + ` Attachments account for ${rawAttachmentBytes} of them.`,
      });
    }

    // A database-backed intent is the final, cross-process gate immediately before SMTP.
    // It remains authoritative if Redis is flushed while another request is still preparing.
    if (idempotencyKey) {
      intentToken = randomUUID();
      let claim: SendIntentClaim;
      try { claim = await claimSendIntent(req.session.userId!, idempotencyKey, sendFingerprint, compatibleFingerprints, intentToken!); }
      catch { return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' }); }
      if (claim.state === 'completed') return res.json(claim.result);
      if (claim.state === 'mismatch') return res.status(409).json({ error: 'This idempotency key belongs to a different message.' });
      if (claim.state === 'uncertain') {
        // §22.1 names this outcome `SEND_OUTCOME_UNKNOWN`, and a code is what lets an interface say what the
        // server is doing correctly instead of showing its sentence.
        return res.status(409).json({
          code: 'SEND_OUTCOME_UNKNOWN',
          error: 'The result of this send is still being confirmed. It will not be sent again automatically.',
        });
      }
      if (claim.state === 'inflight') return res.status(409).json({ error: 'This message is already being sent.' });
      intentClaimed = true;
    }
    if (idemKeyRedis) {
      // TTL comfortably above the worst-case send (large attachment over a slow SMTP
      // server) so the in-flight guard cannot lapse while this request is still running.
      reservationToken = `${INFLIGHT_PREFIX}${intentToken || randomUUID()}`;
      let reserved;
      try { reserved = await redisClient.set(idemKeyRedis, reservationToken, { NX: true, EX: IDEMPOTENCY_LEASE_SECONDS }); }
      catch {
        if (idempotencyKey && intentToken) await releaseSendIntent(req.session.userId!, idempotencyKey, intentToken!).catch(() => {});
        return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' });
      }
      if (reserved !== 'OK') {
        if (idempotencyKey && intentToken) await releaseSendIntent(req.session.userId!, idempotencyKey, intentToken!).catch(() => {});
        return res.status(409).json({ error: 'This message is already being sent.' });
      }
      reservationAcquired = true;
      reservationRenewal = setInterval(() => {
        if (!reservationToken) return;
        void renewIdempotencyLease(idemKeyRedis, reservationToken)
          .then(result => { if (!retainedLease(result)) markLeaseUncertain(true); })
          .catch(() => markLeaseUncertain(true));
      }, IDEMPOTENCY_RENEW_MS);
      reservationRenewal.unref?.();
    }

    // Persist the uncertain state before invoking SMTP: a process crash or lost
    // final DATA acknowledgement cannot then turn into an automatic re-dispatch.
    if (idempotencyKey && intentToken) {
      await markSendIntentUncertain(req.session.userId!, idempotencyKey, intentToken!);
    }
    smtpDispatchStarted = true;
    const smtpInfo = await transport.sendMail(mailOptions);
    delivered = true;
    // Capture recipient outcomes immediately. Any later Sent-folder/metadata failure
    // must return the same SMTP result to both the client and idempotency replay.
    const acceptedRecipients = Array.isArray(smtpInfo.accepted) ? smtpInfo.accepted.map(String) : [];
    const rejectedRecipients = Array.isArray(smtpInfo.rejected) ? smtpInfo.rejected.map(String) : [];
    smtpRecipients = { accepted: acceptedRecipients, rejected: rejectedRecipients };

    // Auto-learn sent recipients so they rank above inbound-only senders in autocomplete.
    // Fire-and-forget — a DB error here must never affect the send response.
    const allRecipients = [...normalizedTo, ...normalizedCc, ...normalizedBcc];
    if (allRecipients.length) {
      const userId = req.session.userId!;
      const now = new Date();
      setImmediate(async () => {
        try {
          // Ensure the user's default address book exists
          const abResult = await query(
            `INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal')
             ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [userId]
          );
          const addressBookId = abResult.rows[0].id;

          const results = await Promise.allSettled(allRecipients.map(addr => {
            const { name, email } = parseAddress(String(addr ?? ''));
            if (!email) return Promise.resolve(null);
            const primaryEmail = email.toLowerCase();
            const displayName = name || primaryEmail;
            const uid    = randomUUID();
            const emails = [{ value: primaryEmail, type: 'other', primary: true }];
            const vcard  = generateVCard({ uid, displayName, emails });
            const etag   = createHash('md5').update(vcard).digest('hex');
            // Upsert by (user_id, primary_email) — bump send_count and promote from is_auto.
            // On conflict, preserve an existing vcard; only fill it in if the row had none.
            return query(`
              INSERT INTO contacts (
                address_book_id, user_id, uid, vcard, etag,
                display_name, primary_email, emails, is_auto, send_count, last_sent
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, 1, $9)
              ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE
                SET send_count   = contacts.send_count + 1,
                    last_sent    = $9,
                    is_auto      = false,
                    display_name = CASE WHEN contacts.is_auto THEN $6 ELSE contacts.display_name END,
                    vcard        = COALESCE(contacts.vcard, EXCLUDED.vcard),
                    etag         = COALESCE(contacts.etag,  EXCLUDED.etag),
                    updated_at   = NOW()
              RETURNING address_book_id
            `, [addressBookId, userId, uid, vcard, etag, displayName, primaryEmail, JSON.stringify(emails), now]);
          }));

          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length) console.warn('Contact upsert errors:', failed.map(r => r.reason?.message));

          // Collect distinct address books actually modified (contacts may live in non-default books).
          const booksToSync = new Set();
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value?.rows?.[0]?.address_book_id) {
              booksToSync.add(r.value.rows[0].address_book_id);
            }
          }
          if (!booksToSync.size) booksToSync.add(addressBookId);

          await Promise.all([...booksToSync].map(bookId =>
            query('UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1', [bookId])
          ));
        } catch (caught) {
          const err = toAppError(caught);
          console.warn('Contact upsert setup error:', err.message);
        }
      });
    }

    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect,
    // but a mapping pointing at a non-selectable folder is ignored in favour of \Sent — #386).
    const sentFolder = await resolveSentFolder(accountId, account.folder_mappings);
    console.log(`Post-send: ${redactEmail(account.email_address || '')} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

    // sentCopySaved: null = not applicable (server auto-saves, or no Sent folder resolved);
    // true/false = whether OUR IMAP APPEND landed the Sent copy. Surfaced to the client so
    // it can warn when a delivered message could not be saved to Sent.
    let sentCopySaved = null;
    const sentMeta = sentFolder ? {
      messageId,
      subject: normalizedSubject,
      fromName,
      fromEmail,
      to: mapRecipientList(normalizedTo),
      cc: mapRecipientList(normalizedCc),
      snippet: buildSentSnippet(body, inputBodyIsHtml),
      date: new Date(),
      // Carried so the Sent row threads into its conversation via the References chain
      // rather than orphaning at its own Message-ID (#378).
      inReplyTo: mailOptions.inReplyTo || null,
      references: mailOptions.references || null,
    } : null;

    if (sentFolder) {
      if (!serverAutoSaves) {
        // Non-auto-saving account: APPEND the Sent copy ourselves — exactly ONCE. IMAP
        // APPEND is NOT idempotent (unlike a \Seen flag), so we must not retry: a retry
        // whose first attempt merely timed out (but still lands on the server) would store
        // a SECOND copy. Bound the wait so a stalled connection can't hang the response;
        // the abandoned append can at worst still save the single copy. On failure, warn
        // the user and schedule a fallback sync in case the append landed late. Audit [2].
        sentCopySaved = false;
        try {
          const { uid } = await Promise.race([
            imapManager.appendToSent(account, sentFolder, rawMessage),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Sent APPEND timed out')), 20000)),
          ]);
          sentCopySaved = true;
          if (uid && sentMeta) {
            await imapManager.upsertSentMessageRecord(account, sentFolder, uid, sentMeta)
              .catch(err => console.warn('Sent metadata upsert failed:', err.message));
          }
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder)
              // Once the Sent copy is in the DB, notify label plugins the message synced: GTD
              // re-runs transitions for its thread (a reply to a Todo/Someday thread means the
              // owner acted, so that label should drop). The sent message reaches no other hook
              // (Sent isn't INBOX, and the tick watches only the state folders), so this is the
              // only trigger. The hook swallows per-plugin errors — the next inbound sync / tick
              // self-heals.
              .then(() => pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId }))
              .catch(e => console.error(`Post-append sync failed: ${e.message}`));
          }, 1000);
        } catch (caught) {
          const appendErr = toAppError(caught);
          console.error(`IMAP append to Sent failed for ${redactEmail(account.email_address || '')}/${sentFolder}: ${appendErr.message}`);
          // The append may still have landed (or land shortly) — pull the folder so a
          // late-completing append self-corrects the DB rather than staying invisible.
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder)
              .catch(e => console.error(`Post-append fallback sync failed: ${e.message}`));
          }, 8000);
        }
      } else {
        // Verify provider autosave before falling back to exactly one APPEND. This keeps
        // OAuth/Gmail accounts free of routine duplicates while preventing a delivered
        // message from being absent in another IMAP client when provider autosave fails.
        setImmediate(() => {
          ensureServerAutoSavedSentCopy({
            account,
            sentFolder,
            messageId,
            rawMessage,
            sentMeta,
          }).then(result => {
            if (!result.saved) return;
            return imapManager.syncFolderOnDemand(account, sentFolder)
              .then(() => pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId }));
          }).catch(err => console.error(`Post-send Sent-copy verification failed: ${err.message}`));
        });
      }
    }

    const sendResult: { ok: boolean; sentCopySaved?: boolean; sentFolder?: string; accepted?: string[]; rejected?: string[]; partialDelivery?: boolean } = { ok: true };
    // A server can accept some RCPT commands and reject others without throwing. Preserve
    // that non-retryable partial outcome so the client never assumes every recipient got it.
    if (rejectedRecipients.length) {
      sendResult.partialDelivery = true;
      sendResult.accepted = acceptedRecipients;
      sendResult.rejected = rejectedRecipients;
    }
    // Surface only the problem case so existing success handling is unchanged; the UI warns
    // when a delivered message could not be saved to the account's Sent folder.
    if (sentCopySaved === false) sendResult.sentCopySaved = false;
    // Tell the client which Sent folder we actually resolved to, so its post-send "View"
    // navigates to the real folder rather than recomputing from a possibly-stale mapping (#386).
    if (sentFolder) sendResult.sentFolder = sentFolder;
    // Overwrite the in-flight reservation with the final result so a retry after a lost
    // response returns this instead of re-sending.
    stopReservationRenewal();
    if (idempotencyKey && intentToken) {
      finalizationStarted = true;
      await completeSendIntent(req.session.userId!, idempotencyKey, intentToken!, sendResult)
        .catch(() => markSendIntentUncertain(req.session.userId!, idempotencyKey!, intentToken!).catch(() => {}));
    }
    if (idemKeyRedis && reservationToken) void completeIdempotencyLease(idemKeyRedis, reservationToken, {
      version: 1, fingerprint: sendFingerprint, result: sendResult,
    }).catch(() => markLeaseUncertain());
    res.json(sendResult);
  } catch (caught) {
    const err = toAppError(caught);
    if (delivered) {
      // SMTP already accepted this message. A Sent-folder or metadata failure
      // must not invite the user to send it again.
      console.error('Post-send processing failed:', err.message);
      const sendResult = {
        ok: true,
        sentCopySaved: false,
        ...(smtpRecipients?.rejected.length ? {
          partialDelivery: true,
          accepted: smtpRecipients.accepted,
          rejected: smtpRecipients.rejected,
        } : {}),
      };
      stopReservationRenewal();
      if (idempotencyKey && intentToken) {
        finalizationStarted = true;
        await completeSendIntent(req.session.userId!, idempotencyKey, intentToken!, sendResult)
          .catch(() => markSendIntentUncertain(req.session.userId!, idempotencyKey!, intentToken!).catch(() => {}));
      }
      if (idemKeyRedis && reservationToken) void completeIdempotencyLease(idemKeyRedis, reservationToken, {
        version: 1, fingerprint: sendFingerprint, result: sendResult,
      }).catch(() => markLeaseUncertain());
      return res.json(sendResult);
    }
    console.error('Send failed:', err.message);
    stopReservationRenewal();
    const retryableFailure = !smtpDispatchStarted || isExplicitSmtpRejection(caught) || isDefinitelyPreDeliveryFailure(caught);
    if (retryableFailure) {
      // A structured 4xx/5xx response is a known SMTP rejection, so DATA was not
      // accepted. Complete both releases before responding: the same idempotency
      // key can then make a sequential retry without racing a stale reservation.
      if (idempotencyKey && intentClaimed && intentToken) {
        await releaseSendIntent(req.session.userId!, idempotencyKey, intentToken!)
          .catch(() => markSendIntentUncertain(req.session.userId!, idempotencyKey!, intentToken!).catch(() => {}));
      }
      if (idemKeyRedis && reservationAcquired && reservationToken) {
        await releaseIdempotencyLease(idemKeyRedis, reservationToken).catch(() => {});
      }
      return res.status(500).json({ error: sanitizeSmtpError(err) });
    }
    // sendMail rejected after dispatch began without an explicit SMTP rejection.
    // DATA may have been accepted, so retain the durable uncertain intent and do
    // not release the Redis lease; retries must reconcile rather than re-dispatch.
    if (idempotencyKey && intentToken) void markSendIntentUncertain(req.session.userId!, idempotencyKey, intentToken!).catch(() => {});
    return res.status(502).json({ error: 'The mail server response was interrupted after dispatch began. This message will not be sent again automatically.' });
  }
});

export default router;

/**
 * The ceiling on one composed message, in bytes.
 *
 * The default is Gmail's raw-message limit (25 MiB) because it is the lowest ceiling an installation is likely to
 * meet, and a provider's own limit can still be lower: passing this check means the installation accepted the
 * message, not that the provider will. `MAIL_MAX_MESSAGE_BYTES` raises it for servers that permit more.
 */
export function mailMaxMessageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MAIL_MAX_MESSAGE_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return 25 * 1024 * 1024;
}
