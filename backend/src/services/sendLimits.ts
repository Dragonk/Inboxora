/**
 * The size limits a send is measured against, in one place.
 *
 * They were four literals and locals scattered through `routes/send.ts` — two of them
 * the same `26_214_400`, two of them `mailMaxMessageBytes()` — which made the
 * *relationship* between them accidental: raising one did not raise the others, and
 * nothing said which dimension a refusal belonged to. The plan asks for a definition
 * shared with the composer rather than a constant chosen inside the route; this is that
 * definition, and the route now reads from it instead of from literals.
 *
 * The kinds are distinct because a refusal has to name which one was hit — a client that
 * has to match English prose to learn whether it sent too many files, too many bytes of
 * attachments, or a message that is too large cannot act on the answer.
 */
export const SEND_LIMIT_KINDS = ['attachment', 'attachments', 'mime', 'http_body'] as const;
export type SendLimitKind = typeof SEND_LIMIT_KINDS[number];

export interface SendLimits {
  /** One attachment after base64 decoding. */
  attachmentBytes: number;
  /** Every attachment of one message together. */
  attachmentsBytes: number;
  /** The composed RFC-822 message. */
  mimeBytes: number;
  /** The JSON request body carrying the message, before parsing. */
  httpBodyBytes: number;
}

/** 25 MiB — Gmail's raw-message limit, the lowest ceiling an installation is likely to meet. */
export const SEND_ATTACHMENT_TOTAL_BYTES = 26_214_400;

/**
 * The composed-message ceiling. `MAIL_MAX_MESSAGE_BYTES` raises it for servers that permit
 * more; passing this check means the *installation* accepted the message, not that the
 * provider will.
 */
export function mailMaxMessageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MAIL_MAX_MESSAGE_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return SEND_ATTACHMENT_TOTAL_BYTES;
}

/**
 * A single definition, derived together so the relationship cannot drift: the
 * per-attachment ceiling and the composed-message ceiling are the same number today, and
 * they are set from one call rather than from two independent ones.
 */
export function sendLimits(env: NodeJS.ProcessEnv = process.env): SendLimits {
  const message = mailMaxMessageBytes(env);
  return {
    attachmentBytes: message,
    attachmentsBytes: SEND_ATTACHMENT_TOTAL_BYTES,
    mimeBytes: message,
    httpBodyBytes: SEND_ATTACHMENT_TOTAL_BYTES + 10 * 1024 * 1024,
  };
}

export interface SendLimitRefusal {
  kind: SendLimitKind;
  code: 'ATTACHMENT_TOO_LARGE' | 'MESSAGE_TOO_LARGE' | 'REQUEST_TOO_LARGE';
  actualBytes: number;
  limitBytes: number;
}

/** The attachment-total refusal, as a value rather than a `res.status(413)` written inline. */
export function attachmentTotalRefusal(actualBytes: number, limits: SendLimits = sendLimits()): SendLimitRefusal | null {
  if (actualBytes <= limits.attachmentsBytes) return null;
  return { kind: 'attachments', code: 'ATTACHMENT_TOO_LARGE', actualBytes, limitBytes: limits.attachmentsBytes };
}

/** The composed-message refusal, kept separate because it is a different dimension. */
export function messageSizeRefusal(actualBytes: number, limits: SendLimits = sendLimits()): SendLimitRefusal | null {
  if (actualBytes <= limits.mimeBytes) return null;
  return { kind: 'mime', code: 'MESSAGE_TOO_LARGE', actualBytes, limitBytes: limits.mimeBytes };
}
