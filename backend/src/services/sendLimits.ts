import {
  GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
  mailTransportCapabilities,
  type MailTransportKind,
} from './providers/mailCapabilities.js';

/**
 * The size limits a send is measured against, resolved **per transport** (P06).
 *
 * The dimensions are separate because a refusal has to name the one it hit, and because they are genuinely
 * different measurements of genuinely different things:
 *
 *  - `attachment` / `attachments` count **decoded binary bytes** — what the provider stores;
 *  - `inline_images` counts the inline images the composer turns `data:` URIs into, so that budget can be
 *    reasoned about on its own without becoming a second, silent total;
 *  - `composed_message` counts the **rendered RFC-822 message** (headers, base64 growth, separators, CRLF) —
 *    the SMTP arm's real artefact;
 *  - `provider_raw_message` counts the final raw representation a provider is handed (Gmail's decoded raw);
 *  - `provider_upload_file` counts one provider upload object (a Graph upload-session file);
 *  - `http_body` counts the JSON request body, which is larger than any of them because it carries base64.
 *
 * Mixing those up is how a message whose *files* fit gets refused for its *encoding*, or a provider that
 * accepts a 40 MB file through an upload session gets refused by an SMTP-era 25 MB constant. The effective
 * limit for one send is therefore
 *
 *     effective = min(installation hard ceiling, provider ceiling, operation-specific ceiling)
 *
 * with two deliberate rules:
 *
 *  1. a provider that declares a ceiling keeps it — the installation's *fallback* message ceiling applies
 *     only to a transport that declares none (SMTP), and never silently shrinks a declared provider limit;
 *  2. the installation's **hard** attachment ceiling (`MAIL_MAX_ATTACHMENT_BYTES`) does bound every
 *     transport, so an operator still has one number that means "no message larger than this leaves here".
 */

export const SEND_LIMIT_DIMENSIONS = [
  'attachment',
  'attachments',
  'inline_images',
  'composed_message',
  'provider_raw_message',
  'provider_upload_file',
  'http_body',
] as const;
export type SendLimitDimension = typeof SEND_LIMIT_DIMENSIONS[number];

export const SEND_LIMIT_CODES = [
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENTS_TOO_LARGE',
  'INLINE_IMAGES_TOO_LARGE',
  'MESSAGE_TOO_LARGE',
  'PROVIDER_MESSAGE_TOO_LARGE',
  'PROVIDER_UPLOAD_TOO_LARGE',
  'REQUEST_TOO_LARGE',
] as const;
export type SendLimitCode = typeof SEND_LIMIT_CODES[number];

/** The dimensions a send is measured against, once resolved for its transport. */
export interface EffectiveSendLimits {
  transport: MailTransportKind;
  /** One attachment, decoded bytes. */
  singleAttachmentBytes: number;
  /** Every attachment of one message together, decoded bytes. */
  totalAttachmentBytes: number;
  /** The inline images the composer turns into CID attachments, decoded bytes. */
  inlineImageBytes: number;
  /** The rendered RFC-822 message the SMTP arm hands to its transport. */
  composedMessageBytes: number;
  /** The provider's own ceiling on its final raw representation; `Infinity` when it has none. */
  providerRawMessageBytes: number;
  /** The provider's upload-object file ceiling; `Infinity` when it has no upload object. */
  providerUploadFileBytes: number;
  /** Above this an attachment needs the provider's upload object rather than travelling inline. */
  uploadSessionThresholdBytes: number;
  /** The whole-message ceiling the provider declares; `Infinity` when it declares none. */
  providerMessageBytes: number;
  /** The JSON request body window the send route accepts, before it applies the limits above. */
  httpRequestBodyBytes: number;
  /** True when `composedMessageBytes` came from the installation fallback rather than from a provider. */
  composedMessageFromFallback: boolean;
}

/** 25 MiB — Gmail's documented raw-message limit, and the historical default fallback ceiling. */
export const SEND_ATTACHMENT_TOTAL_BYTES = 26_214_400;

/** The HTTP body window is the hard attachment ceiling carried as base64, plus JSON and header slack. */
const HTTP_BODY_OVERHEAD_BYTES = 10 * 1024 * 1024;

/**
 * The **fallback** composed-message ceiling, used for a transport that declares no message ceiling of its own.
 *
 * `MAIL_MAX_MESSAGE_BYTES` raises it for servers that permit more; it is not a provider limit, and it does not
 * cap a provider that declares one. Passing this check means the *installation* accepted the message.
 */
export function mailMaxMessageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MAIL_MAX_MESSAGE_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return SEND_ATTACHMENT_TOTAL_BYTES;
}

/**
 * The **hard** ceiling on one attachment and on all attachments of one message, applying to every transport.
 *
 * It defaults to the largest file any supported provider can carry (Graph's upload-session ceiling), so an
 * installation that configures nothing is not silently capping Graph at the SMTP-era 25 MB. Setting it lower
 * is how an operator caps the whole installation regardless of what a provider would accept.
 */
export function mailMaxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MAIL_MAX_ATTACHMENT_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES;
}

/** The JSON body window this route accepts: the hard ceiling as base64 plus slack for headers and JSON. */
export function sendHttpBodyWindowBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(mailMaxAttachmentBytes(env) * 4 / 3) + HTTP_BODY_OVERHEAD_BYTES;
}

/**
 * Resolve the limits one send is measured against.
 *
 * A provider ceiling wins over the fallback; the installation's hard ceiling bounds both.
 */
export function effectiveSendLimits(transport: MailTransportKind, env: NodeJS.ProcessEnv = process.env): EffectiveSendLimits {
  const capabilities = mailTransportCapabilities(transport);
  const hard = mailMaxAttachmentBytes(env);
  const fallbackMessage = mailMaxMessageBytes(env);

  const providerMessageBytes = capabilities.messageBytes ?? Number.POSITIVE_INFINITY;
  const providerRawMessageBytes = capabilities.rawMessageBytes ?? Number.POSITIVE_INFINITY;
  const providerUploadFileBytes = capabilities.uploadSessionFileBytes ?? Number.POSITIVE_INFINITY;
  const uploadSessionThresholdBytes = capabilities.uploadSessionThresholdBytes ?? Number.POSITIVE_INFINITY;

  // The provider's declared ceiling is the message ceiling; the fallback applies only where none is declared.
  const messageCeiling = capabilities.messageBytes ?? fallbackMessage;
  const totalAttachmentBytes = Math.min(hard, messageCeiling);
  const singleAttachmentBytes = Math.min(hard, capabilities.singleAttachmentBytes ?? messageCeiling);

  return {
    transport,
    singleAttachmentBytes,
    totalAttachmentBytes,
    // Inline images are attachments too, so their own budget can never exceed the total.
    inlineImageBytes: totalAttachmentBytes,
    // The SMTP arm renders the message the route measures. A transport that composes its own representation
    // is measured in its own terms (`providerRawMessageBytes`) instead, so the fallback never bounds it.
    composedMessageBytes: messageCeiling,
    providerRawMessageBytes,
    providerUploadFileBytes,
    uploadSessionThresholdBytes,
    providerMessageBytes,
    httpRequestBodyBytes: sendHttpBodyWindowBytes(env),
    composedMessageFromFallback: capabilities.messageBytes === null,
  };
}

export interface SendLimitRefusal {
  dimension: SendLimitDimension;
  code: SendLimitCode;
  actualBytes: number;
  limitBytes: number;
  transport: MailTransportKind;
  /** Present when the refusal is about one named file, so the interface can point at it. */
  filename?: string;
}

function refusal(
  dimension: SendLimitDimension,
  code: SendLimitCode,
  actualBytes: number,
  limitBytes: number,
  limits: EffectiveSendLimits,
  filename?: string,
): SendLimitRefusal | null {
  if (actualBytes <= limitBytes) return null;
  return {
    dimension,
    code,
    actualBytes,
    limitBytes,
    transport: limits.transport,
    ...(filename ? { filename } : {}),
  };
}

/** One attachment, decoded bytes. */
export function attachmentRefusal(actualBytes: number, limits: EffectiveSendLimits, filename?: string): SendLimitRefusal | null {
  return refusal('attachment', 'ATTACHMENT_TOO_LARGE', actualBytes, limits.singleAttachmentBytes, limits, filename);
}

/** Every attachment together, decoded bytes. */
export function attachmentsRefusal(actualBytes: number, limits: EffectiveSendLimits): SendLimitRefusal | null {
  return refusal('attachments', 'ATTACHMENTS_TOO_LARGE', actualBytes, limits.totalAttachmentBytes, limits);
}

/** The inline images the composer created, decoded bytes. */
export function inlineImagesRefusal(actualBytes: number, limits: EffectiveSendLimits): SendLimitRefusal | null {
  return refusal('inline_images', 'INLINE_IMAGES_TOO_LARGE', actualBytes, limits.inlineImageBytes, limits);
}

/** The rendered RFC-822 message (SMTP). */
export function messageSizeRefusal(actualBytes: number, limits: EffectiveSendLimits): SendLimitRefusal | null {
  return refusal('composed_message', 'MESSAGE_TOO_LARGE', actualBytes, limits.composedMessageBytes, limits);
}

/** The provider's own raw-representation ceiling (Gmail). */
export function providerRawMessageRefusal(actualBytes: number, limits: EffectiveSendLimits): SendLimitRefusal | null {
  return refusal('provider_raw_message', 'PROVIDER_MESSAGE_TOO_LARGE', actualBytes, limits.providerRawMessageBytes, limits);
}

/** One provider upload object (a Graph upload-session file). */
export function providerUploadFileRefusal(actualBytes: number, limits: EffectiveSendLimits, filename?: string): SendLimitRefusal | null {
  return refusal('provider_upload_file', 'PROVIDER_UPLOAD_TOO_LARGE', actualBytes, limits.providerUploadFileBytes, limits, filename);
}

/** The JSON request body itself. */
export function httpBodyRefusal(actualBytes: number, limits: EffectiveSendLimits): SendLimitRefusal | null {
  return refusal('http_body', 'REQUEST_TOO_LARGE', actualBytes, limits.httpRequestBodyBytes, limits);
}

/** The decoded byte count a base64 payload carries, without decoding it. */
export function decodedBase64Bytes(content: string): number {
  if (typeof content !== 'string') return 0;
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(content.length * 3 / 4) - padding);
}

/**
 * The human sentence for a refusal. Clients act on `code`/`dimension`; this is the fallback text for anything
 * that does not, and it names the transport so an operator reading a log knows which ceiling was hit.
 */
export function sendLimitRefusalMessage(refusal: SendLimitRefusal): string {
  const transport = refusal.transport === 'smtp' ? 'this account\u2019s mail server'
    : refusal.transport === 'microsoft_graph' ? 'Microsoft Graph'
      : 'Gmail';
  switch (refusal.dimension) {
    case 'attachment':
      return `The attachment${refusal.filename ? ` "${refusal.filename}"` : ''} is ${refusal.actualBytes} bytes, above the ${refusal.limitBytes}-byte per-attachment limit for ${transport}.`;
    case 'attachments':
      return `The attachments total ${refusal.actualBytes} bytes, above the ${refusal.limitBytes}-byte limit for ${transport}.`;
    case 'inline_images':
      return `The inline images total ${refusal.actualBytes} bytes, above the ${refusal.limitBytes}-byte limit for ${transport}.`;
    case 'composed_message':
      return `The composed message is ${refusal.actualBytes} bytes, above the ${refusal.limitBytes}-byte limit for ${transport}.`;
    case 'provider_raw_message':
      return `The composed message is ${refusal.actualBytes} bytes, above ${transport}\u2019s ${refusal.limitBytes}-byte limit.`;
    case 'provider_upload_file':
      return `The attachment${refusal.filename ? ` "${refusal.filename}"` : ''} is ${refusal.actualBytes} bytes, above ${transport}\u2019s ${refusal.limitBytes}-byte upload limit.`;
    case 'http_body':
      return `The request body is ${refusal.actualBytes} bytes, above the ${refusal.limitBytes}-byte limit this installation accepts.`;
  }
}

/** The JSON response body for a refusal: the domain facts only, so no client has to match English prose. */
export function sendLimitRefusalBody(refusal: SendLimitRefusal): {
  code: SendLimitCode;
  dimension: SendLimitDimension;
  actualBytes: number;
  limitBytes: number;
  transport: MailTransportKind;
  filename?: string;
  error: string;
} {
  return {
    code: refusal.code,
    dimension: refusal.dimension,
    actualBytes: refusal.actualBytes,
    limitBytes: refusal.limitBytes,
    transport: refusal.transport,
    ...(refusal.filename ? { filename: refusal.filename } : {}),
    error: sendLimitRefusalMessage(refusal),
  };
}
