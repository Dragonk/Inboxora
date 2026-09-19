import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { Readable } from 'node:stream';
import { stripHeaderFromMessage } from './mimeHeaders.js';

/**
 * The canonical, transport-independent model of a message Inboxora is about to send.
 *
 * `semantic composition → ComposedMail → provider-specific renderer`. The model is **not** a wire
 * format: MIME is SMTP's representation of it, a Graph `microsoft.graph.message` will be Graph's, and
 * the renderer — not the composer — decides which. That is what keeps blind recipients representable:
 * the model carries `bcc` as data, and each transport renders it the way that transport can express it
 * (SMTP: envelope only, never a header; Graph: `bccRecipients`, out of band).
 *
 * Recipients are structured — an address and an optional display name — because that is the shape the
 * transports disagree about: SMTP wants the name in the header and only the address in the envelope, Graph
 * wants them as two JSON fields. Parsing happens once, before the model is built.
 */
export interface Mailbox {
  email: string;
  name?: string | null;
}

/**
 * Parse one RFC 5322 style address into its two parts, **once**, before the model exists.
 *
 * The interface accepts what people type — `jan@example.com`, `Jan Kowalski <jan@example.com>`,
 * `"Kowalski, Jan" <jan@example.com>` — and each transport needs a different half of it: SMTP puts the
 * display name in the header and **only the address** in the envelope, while Graph keeps them as separate
 * fields (`emailAddress.address` and `emailAddress.name`). Passing the raw string to Graph's `address`
 * produced an address Graph would reject, which is why the split belongs here and not in a renderer.
 */
export function parseMailbox(value: string): Mailbox {
  const trimmed = value.trim();
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  if (!angled) return { email: trimmed };

  const email = angled[2].trim();
  const rawName = angled[1].trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
  return rawName ? { email, name: rawName } : { email };
}

/** The display form used in headers: `Name <address>`, or just the address. */
export const formatMailbox = (mailbox: Mailbox): string =>
  mailbox.name ? `${mailbox.name} <${mailbox.email}>` : mailbox.email;

/** The plain-address list used wherever only addresses are legal (the SMTP envelope). */
export const mailboxAddresses = (mailboxes: readonly Mailbox[]): string[] => mailboxes.map(mailbox => mailbox.email);

export interface ComposedAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Inline image reference, e.g. `logo@inboxora`. */
  cid?: string;
  contentDisposition?: 'attachment' | 'inline';
}

export interface ComposedMail {
  messageId: string;
  from: Mailbox;
  replyTo?: Mailbox | null;
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  subject: string;
  plainBody: string;
  htmlBody?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  priority?: 'high' | 'normal' | 'low';
  /** Safe, caller-controlled headers only. */
  headers?: Record<string, string>;
  attachments?: ComposedAttachment[];
  /** Provider-independent operation metadata (intent/operation ids); never sent as a header. */
  operationMetadata?: Record<string, unknown>;
}

export interface RenderedSmtpMessage {
  /** The composed MIME. Contains **no** `Bcc:` header. */
  raw: Buffer;
  /** The SMTP envelope, which **does** carry the blind recipients. */
  envelope: { from: string; to: string[] };
  /** The options the transport is asked to send, with `raw` supplied by the caller. */
  mailOptions: SendMailOptions;
}

/**
 * Render the model for SMTP: one MIME message without `Bcc`, plus the envelope that carries it.
 *
 * The message is composed **once**, here. The buffer returned is the one a transport is given as `raw`,
 * so it is also the one measured against the size limits — and the `Bcc:` header the composer writes is
 * removed from it (measured: nodemailer's stream transport keeps it, and `keepBcc: false` does not change
 * that), because a raw message is sent as given and a blind recipient must exist only in the envelope.
 */
export async function renderSmtpMessage(composed: ComposedMail): Promise<RenderedSmtpMessage> {
  // The envelope carries addresses only: a display name is a header convenience, and an envelope with one
  // in it is not a valid SMTP recipient.
  const envelope = {
    from: composed.from.email,
    to: mailboxAddresses([...composed.to, ...composed.cc, ...composed.bcc]),
  };

  const mailOptions: SendMailOptions = {
    messageId: composed.messageId,
    from: formatMailbox(composed.from),
    // Stated rather than derived: identical to what nodemailer derives from the three recipient
    // options (verified for to+cc+bcc, for bcc alone and with a display name in `from`), and stating
    // it is what lets the recipients survive the message being sent as `raw`.
    envelope,
    ...(composed.replyTo ? { replyTo: formatMailbox(composed.replyTo) } : {}),
    // Nodemailer uses bcc for the envelope but omits it from generated MIME. Do not add a synthetic
    // To header for a BCC-only message.
    ...(composed.to.length ? { to: composed.to.map(formatMailbox).join(', ') } : {}),
    ...(composed.cc.length ? { cc: composed.cc.map(formatMailbox).join(', ') } : {}),
    ...(composed.bcc.length ? { bcc: composed.bcc.map(formatMailbox).join(', ') } : {}),
    subject: composed.subject,
    ...(composed.priority && composed.priority !== 'normal' ? { priority: composed.priority } : {}),
    text: composed.plainBody,
    ...(composed.htmlBody ? { html: composed.htmlBody } : {}),
    ...(composed.inReplyTo ? { inReplyTo: composed.inReplyTo } : {}),
    ...(composed.references ? { references: composed.references } : {}),
    ...(composed.headers && Object.keys(composed.headers).length ? { headers: composed.headers } : {}),
  };

  if (composed.attachments?.length) {
    mailOptions.attachments = composed.attachments.map(attachment => ({
      filename: attachment.filename,
      content: attachment.content,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.cid ? { cid: attachment.cid } : {}),
      ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
    }));
  }

  // CRLF: RFC 5322 and IMAP APPEND require it, and a bare-LF message is stored verbatim by strict
  // servers, after which downstream clients mis-parse the headers.
  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks: Buffer[] = [];
  const messageStream = streamInfo.message;
  if (!(messageStream instanceof Readable)) {
    throw new Error('Stream transport did not return a readable message');
  }
  await new Promise<void>((resolve, reject) => {
    messageStream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    messageStream.on('end', resolve);
    messageStream.on('error', reject);
  });

  return { raw: stripHeaderFromMessage(Buffer.concat(chunks), 'Bcc'), envelope, mailOptions };
}
