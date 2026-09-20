import { randomBytes } from 'node:crypto';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { query } from './db.js';
import { sanitizeEmail } from './emailSanitizer.js';
import type { AttachmentRef } from './imapManager.js';
import { parseMailbox, renderSmtpMessage, type ComposedMail } from './composedMail.js';
import { createAccountMailTransport, type TransportSendResult } from './sendTransport.js';
import { fetchSourceAttachment } from './sourceAttachments.js';
import { googleConfigFromEnv } from './providerAuthService.js';
import {
  collectGmailInlineImages,
  embedGmailInlineImages,
  fetchGmailMessageContent,
  localAttachmentsForGmail,
} from './providers/google/gmailMailBody.js';
import { microsoftConfigFromEnv } from './providerAuthService.js';
import type { GraphApiOptions } from './providers/microsoft/graphApiClient.js';
import {
  collectGraphInlineImages,
  embedGraphInlineImages,
  fetchGraphAttachments,
  fetchGraphMessageBody,
  localAttachmentsForGraph,
} from './providers/microsoft/graphMailBody.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Raised when the transport could not tell whether the message left the installation.
 *
 * The reservation is deliberately **not** released for this outcome: the provider may have accepted the
 * forward, so a later rule run must reconcile instead of sending a second copy — the same rule the send
 * route applies to an interrupted response.
 */
class ForwardOutcomeUnknownError extends Error {
  constructor() {
    super('Forward delivery outcome is unknown; the reservation stays pending for reconciliation');
    this.name = 'ForwardOutcomeUnknownError';
  }
}

/** The header fields the forwarder reads from any message-like row. */
interface ForwardHeaderRow {
  subject?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  to_addresses?: unknown;
  cc_addresses?: unknown;
  date?: string | number | Date | null;
  [key: string]: unknown;
}

/** A messages-table row the forwarder loads (see migrations/0001_baseline.sql). */
interface ForwardMessageRow extends ForwardHeaderRow {
  id: string;
  account_id: string;
  uid: string | number;
  folder: string;
  /** The provider's immutable id, needed to read a native (Graph) message. Absent on legacy rows. */
  provider_message_id?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  attachments?: unknown;
}

/** The account slice the forwarder needs. */
interface ForwardAccountLike {
  id?: string;
  name?: string | null;
  sender_name?: string | null;
  email_address?: string | null;
  user_id?: string;
  /** Which transport owns the message: `microsoft_graph` is read and sent over Graph, never IMAP/SMTP. */
  mail_transport?: string | null;
  provider_connection_id?: string | null;
  [key: string]: unknown;
}

/** An attachment attached to a forwarded message. */
interface ForwardAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /** Present on an inline body image. */
  cid?: string;
  contentDisposition?: 'attachment' | 'inline';
}

/** The mail-engine methods the forwarder calls. */
interface ForwardImapManager {
  fetchMessageBody(
    account: ForwardAccountLike,
    uid: string | number,
    folder: string
  ): Promise<{ text?: string | null; html?: string | null; attachments?: unknown }>;
  fetchMultipleAttachments(
    account: ForwardAccountLike,
    uid: string | number,
    folder: string,
    parts: AttachmentRef[]
  ): Promise<Map<string, Buffer>>;
}

/** Input to buildForwardMessage. */
interface BuildForwardMessageInput {
  row: ForwardHeaderRow;
  account: ForwardAccountLike;
  recipient: string;
  text?: string | null;
  html?: string | null;
  attachments?: ForwardAttachment[];
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseAddresses(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A recipient as stored on a row: either a plain address or a parsed { name, address } pair. */
type AddressLike = string | { name?: string | null; address?: string | null; email?: string | null };

function formatAddress(address: AddressLike): string {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return '';

  const email = address.address || address.email || '';
  return address.name ? `${address.name} <${email}>` : email;
}

function formatAddresses(value: unknown) {
  return parseAddresses(value).map(formatAddress).filter(Boolean).join(', ');
}

function formatUtcDate(value: unknown) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString();
}

function forwardSubject(value: unknown) {
  const subject = String(value ?? '');
  return /^Fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function htmlToPlainText(value: unknown) {
  const namedEntities = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:blockquote|div|h[1-6]|li|p|pre|tr)\s*>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&#([0-9]+);/g, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&([a-z]+);/gi, (_, name) =>
      namedEntities.get(name.toLowerCase()) ?? ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttachments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Whether a stored attachment entry carries the part reference the fetch needs. */
function isAttachmentRef(value: unknown): value is AttachmentRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'part' in value &&
    typeof value.part === 'string'
  );
}

function forwardedHeaders(row: ForwardHeaderRow) {
  const from = formatAddress({
    name: row.from_name,
    address: row.from_email,
  });
  return [
    ['From', from],
    ['Date', formatUtcDate(row.date)],
    ['Subject', row.subject || ''],
    ['To', formatAddresses(row.to_addresses)],
    ['Cc', formatAddresses(row.cc_addresses)],
  ].filter(([, value]) => value);
}

/** The semantic fields of a forward, before either transport's representation is built. */
interface ForwardFields {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  attachments: ForwardAttachment[];
}

/** The single composition the legacy nodemailer options and the canonical model are both built from. */
function composeForward({
  row,
  account,
  recipient,
  text,
  html,
  attachments = [],
}: BuildForwardMessageInput): ForwardFields {
  const headers = forwardedHeaders(row);
  const forwardHeaderText = [
    '---------- Forwarded message ----------',
    ...headers.map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
  const forwardHeaderHtml = [
    '<div>---------- Forwarded message ----------<br>',
    ...headers.map(([label, value]) =>
      `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}<br>`),
    '</div><br>',
  ].join('');
  const safeHtml = html ? sanitizeEmail(html) : html;
  const plainBody = text || htmlToPlainText(safeHtml);

  return {
    from: `${account.sender_name || account.name} <${account.email_address}>`,
    to: recipient,
    subject: forwardSubject(row.subject),
    text: `${forwardHeaderText}\n\n${plainBody}`,
    html: safeHtml ? `${forwardHeaderHtml}${safeHtml}` : null,
    attachments,
  };
}

export function buildForwardMessage(input: BuildForwardMessageInput) {
  const fields = composeForward(input);
  return {
    from: fields.from,
    to: fields.to,
    subject: fields.subject,
    text: fields.text,
    ...(fields.html ? { html: fields.html } : {}),
    ...(fields.attachments.length ? { attachments: fields.attachments } : {}),
  };
}

/**
 * The same forward as the canonical, transport-independent model the send seam consumes.
 *
 * The rendered fields are the ones `buildForwardMessage` already computes; the only addition is the
 * stable Message-ID a provider needs to be able to file and thread the message. Recipients are parsed
 * here, once, so each transport renders the half it needs.
 */
export function buildForwardComposedMail(
  input: BuildForwardMessageInput & { messageId: string },
): ComposedMail {
  const fields = composeForward(input);
  return {
    messageId: input.messageId,
    from: parseMailbox(fields.from),
    to: [parseMailbox(fields.to)],
    cc: [],
    bcc: [],
    subject: fields.subject,
    plainBody: fields.text,
    htmlBody: fields.html,
    attachments: fields.attachments.map(attachment => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      ...(attachment.cid ? { cid: attachment.cid } : {}),
      ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
    })),
  };
}

/** A stable Message-ID, so a provider copy and any later observation reference the same message. */
function forwardMessageId(account: ForwardAccountLike) {
  const domain = String(account.email_address ?? '').split('@')[1] || 'mailflow.local';
  return `<${randomBytes(16).toString('hex')}@${domain}>`;
}

/** The Graph context one account's reads use, or a named failure when the account cannot be read. */
function graphApiForAccount(account: ForwardAccountLike): GraphApiOptions {
  if (!account.provider_connection_id) {
    throw new Error('This Microsoft account is not linked to a Graph connection. Reconnect the account to forward mail.');
  }
  return {
    userId: account.user_id ?? '',
    connectionId: account.provider_connection_id,
    config: microsoftConfigFromEnv(),
  };
}

function gmailApiForAccount(account: ForwardAccountLike) {
  if (!account.provider_connection_id) {
    throw new Error('This Google account is not linked to a Gmail connection. Reconnect the account to forward mail.');
  }
  return {
    userId: account.user_id ?? '',
    connectionId: account.provider_connection_id,
    config: googleConfigFromEnv(),
  };
}

function ensureAttachmentLimit(attachments: ReadonlyArray<{ content?: { length?: number } | null }>): void {
  const totalBytes = attachments.reduce(
    (sum, attachment) => sum + (attachment.content?.length ?? 0),
    0
  );
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('Total attachment size exceeds 25 MB');
  }
}

async function loadForwardContent({ row, account, imapManager }: {
  row: ForwardMessageRow;
  account: ForwardAccountLike;
  imapManager: ForwardImapManager;
}) {
  // The transport that owns the message decides where its bytes are read from. A native account must
  // never fall back to IMAP: a transport this forwarder has no reader for is named and refused.
  const transport = account.mail_transport ?? 'imap_smtp';
  let text = row.body_text;
  let html = row.body_html;
  let fetchedParts: unknown[] = [];
  if (!text && !html) {
    if (transport === 'microsoft_graph') {
      // The reading half of the Graph adapter — the same reader the body route uses, so a native
      // message is cached and forwarded from one implementation. Inline images are embedded as data
      // URIs and later become CID parts in the shared pipeline, exactly as the IMAP path does.
      if (!row.provider_message_id) {
        throw new Error('This Microsoft message has no Graph identity to read its body from');
      }
      const api = graphApiForAccount(account);
      const providerMessageId = row.provider_message_id;
      const [body, graphAttachments] = await Promise.all([
        fetchGraphMessageBody(api, providerMessageId),
        fetchGraphAttachments(api, providerMessageId),
      ]);
      if (body?.contentType === 'html') {
        const inline = await collectGraphInlineImages(api, providerMessageId, graphAttachments);
        html = embedGraphInlineImages(body.content, inline);
      } else if (body) {
        text = body.content;
      }
      // Only the files a person sees; an inline image belongs to the body and is embedded above.
      fetchedParts = localAttachmentsForGraph(graphAttachments);
    } else if (transport === 'gmail_api') {
      // The reading half of the Gmail adapter — the same reader the message-body route uses, so a native
      // message is cached and forwarded from one implementation. Inline images are embedded as data URIs and
      // later become CID parts in the shared pipeline, exactly as the other transports do.
      if (!row.provider_message_id) {
        throw new Error('This Gmail message has no Gmail API identity to read its body from');
      }
      const api = gmailApiForAccount(account);
      const providerMessageId = row.provider_message_id;
      const content = await fetchGmailMessageContent(api, providerMessageId);
      if (content.html) {
        const inline = await collectGmailInlineImages(api, providerMessageId, content.attachments);
        html = embedGmailInlineImages(content.html, inline);
      } else if (content.text) {
        text = content.text;
      }
      // Only the files a person sees; an inline image belongs to the body and is embedded above.
      fetchedParts = localAttachmentsForGmail(content.attachments);
    } else if (transport === 'imap_smtp') {
      const fetched = await imapManager.fetchMessageBody(
        account,
        row.uid,
        row.folder
      );
      text = fetched.text;
      html = fetched.html;
      fetchedParts = parseAttachments(fetched.attachments);
    } else {
      throw new Error(`Forwarding from a ${transport} source is not supported yet`);
    }
  }

  const storedParts: AttachmentRef[] = [];
  const seenParts = new Set<string>();
  for (const candidate of [
    ...parseAttachments(row.attachments),
    ...fetchedParts,
  ]) {
    if (!isAttachmentRef(candidate)) continue;
    const partKey = String(candidate.part);
    if (seenParts.has(partKey)) continue;
    seenParts.add(partKey);
    storedParts.push(candidate);
  }
  const knownBytes = storedParts.reduce(
    (sum, attachment) =>
      sum + (Number.isFinite(Number(attachment.size))
        ? Number(attachment.size)
        : 0),
    0
  );
  if (knownBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('Total attachment size exceeds 25 MB');
  }

  let fetchedAttachments: ForwardAttachment[] = [];
  const nativeTransport = transport === 'microsoft_graph' || transport === 'gmail_api';
  if (storedParts.length && nativeTransport) {
    // Read the bytes from the account that owns the message, through the shared dispatcher: a native
    // attachment is addressed by its provider id, under the per-file ceiling. The IMAP callback exists only
    // to satisfy the dispatcher's contract for other transports; it is never reached here and refuses loudly
    // rather than silently opening a mailbox a native account does not have.
    if (typeof account.id !== 'string' || typeof account.user_id !== 'string') {
      throw new Error('This account is missing the identity needed to read its attachments');
    }
    const sourceAccount = {
      id: account.id,
      user_id: account.user_id,
      mail_transport: transport,
      provider_connection_id: account.provider_connection_id ?? null,
    };
    for (const attachment of storedParts) {
      const content = await fetchSourceAttachment({
        account: sourceAccount,
        message: {
          uid: row.uid,
          folder: row.folder,
          provider_message_id: row.provider_message_id ?? null,
        },
        attachment: { part: attachment.part, filename: attachment.filename },
        imap: () => Promise.reject(new Error('A native account must never be read over IMAP')),
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      fetchedAttachments.push({
        filename: attachment.filename || 'attachment',
        content,
        contentType: attachment.type || 'application/octet-stream',
      });
    }
  } else if (storedParts.length) {
    const buffers = await imapManager.fetchMultipleAttachments(
      account,
      row.uid,
      row.folder,
      storedParts
    );
    fetchedAttachments = storedParts.map(attachment => {
      const content = buffers.get(attachment.part);
      if (!content) {
        throw new Error('Forward attachment unavailable');
      }
      return {
        filename: attachment.filename || 'attachment',
        content,
        contentType: attachment.type || 'application/octet-stream',
      };
    });
  }

  const safeHtml = html ? sanitizeEmail(html) : html;
  const embedded = typeof safeHtml === 'string'
    ? embedInlineDataImages(safeHtml)
    : embedInlineDataImages(safeHtml);
  const attachments = [
    ...embedded.attachments,
    ...fetchedAttachments,
  ];
  ensureAttachmentLimit(attachments);

  return {
    text,
    html: embedded.html,
    attachments,
  };
}

export async function forwardRuleMessage({
  ruleId,
  message,
  account,
  imapManager,
  recipient,
}: {
  ruleId: string;
  message: { id: string };
  account: ForwardAccountLike;
  imapManager: ForwardImapManager;
  recipient: string;
}) {
  const reserved = await query(
    `INSERT INTO inbox_rule_forwards (rule_id, message_id)
     VALUES ($1, $2)
     ON CONFLICT (rule_id, message_id) DO NOTHING
     RETURNING id`,
    [ruleId, message.id]
  );
  if (!reserved.rows.length) {
    const existing = await query(
      `SELECT status
       FROM inbox_rule_forwards
       WHERE rule_id = $1 AND message_id = $2`,
      [ruleId, message.id]
    );
    if (existing.rows[0]?.status === 'sent') return 'duplicate';
    throw new Error('Forward delivery pending');
  }

  const reservationId = reserved.rows[0].id;
  let delivered = false;
  try {
    const rowResult = await query<ForwardMessageRow>(
      `SELECT id, account_id, uid, folder, provider_message_id, subject, from_name, from_email,
              to_addresses, cc_addresses, date, body_text, body_html, attachments
       FROM messages
       WHERE id = $1 AND account_id = $2`,
      [message.id, account.id]
    );
    if (!rowResult.rows.length) {
      throw new Error('Forward source message not found');
    }
    const row = rowResult.rows[0];

    const content = await loadForwardContent({ row, account, imapManager });
    const composed = buildForwardComposedMail({
      messageId: forwardMessageId(account),
      row,
      account,
      recipient,
      ...content,
    });

    // Bind the account to the seam that owns "how mail leaves this installation". A native account
    // is bound to Graph here, so no SMTP factory call and no SMTP object exist for it.
    const bound = await createAccountMailTransport(account);
    if ('error' in bound) throw new Error(bound.error);
    const transport = bound.transport;

    // Only the transport that dispatches the rendered RFC-822 message needs it; Graph renders its own
    // representation from the model, so no SMTP message is built for a native account.
    const rendered = transport.sendsRenderedMessage ? await renderSmtpMessage(composed) : null;

    let outcome: TransportSendResult;
    try {
      outcome = await transport.send({ composed, ...(rendered ? { rendered } : {}) });
    } catch {
      // SMTP keeps its existing semantics: a protocol failure is a failed delivery and the pending
      // reservation is released so a deliberate retry can send.
      throw new Error('Forward delivery failed');
    }

    if (outcome.status === 'outcome_unknown') {
      // The provider may or may not have the message. The reservation stays pending: a later rule run
      // must reconcile rather than send a second copy, and nothing is reported as sent.
      throw new ForwardOutcomeUnknownError();
    }
    if (outcome.status === 'refused') {
      // A refusal read before acceptance: nothing left for the recipients, so the reservation is
      // released for a deliberate retry.
      throw new Error(`Forward delivery refused (${outcome.code}): ${outcome.error}`);
    }

    delivered = true;
    await query(
      `UPDATE inbox_rule_forwards
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1`,
      [reservationId]
    );
    return 'sent';
  } catch (err) {
    if (!delivered && !(err instanceof ForwardOutcomeUnknownError)) {
      await query(
        `DELETE FROM inbox_rule_forwards
         WHERE id = $1 AND status = 'pending'`,
        [reservationId]
      ).catch(() => {});
    }
    throw err;
  }
}
