/**
 * What each **mail transport** accepts, in one definition (P06).
 *
 * These are provider facts, not installation policy: Graph's 3 MB is where an attachment must stop travelling
 * inline in the create call and move to a resumable upload session (a choice of *method*, not a ceiling), its
 * 150 MB is the largest single file such a session accepts and also Exchange's own maximum message size, and
 * Gmail's 25 MB is a ceiling on the raw message it will accept. Keeping them here — rather than as literals
 * inside the adapter that happens to hit them — is what lets the send limit model be *derived* per transport
 * instead of guessed, and it is why `graphMailAttachments.ts` and `gmailApi.ts` now read their numbers from
 * this module rather than owning them.
 *
 * `null` means **the transport declares no such ceiling**, which is a different statement from "zero": SMTP is
 * the case that matters, because there is no universal SMTP message limit and the installation's configured
 * fallback is what applies. A provider ceiling is never replaced by that fallback — an installation that
 * lowers its own message ceiling lowers the effective one, but an installation that leaves it at the default
 * does not thereby cap a provider that declared a larger one.
 */
export type MailTransportKind = 'smtp' | 'microsoft_graph' | 'gmail_api';

export interface MailTransportCapabilities {
  kind: MailTransportKind;
  /** The provider's own ceiling on one attachment, in decoded bytes. */
  singleAttachmentBytes: number | null;
  /** The provider's own ceiling on the whole message it accepts. */
  messageBytes: number | null;
  /**
   * The provider's ceiling on the final raw representation it is handed, measured on the decoded RFC-822
   * bytes (Gmail). `null` when the provider has no such representation to bound.
   */
  rawMessageBytes: number | null;
  /** Above this, an attachment needs a provider upload object instead of travelling inline. */
  uploadSessionThresholdBytes: number | null;
  /** The largest single file the provider's upload object accepts. */
  uploadSessionFileBytes: number | null;
}

/** Graph stops accepting an attachment inline in the create call above this; it is a method threshold. */
export const GRAPH_INLINE_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** The largest single file a Graph upload session accepts. */
export const GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES = 150 * 1024 * 1024;
/** Exchange's maximum message size, which is the whole-message ceiling a Graph send is bounded by. */
export const GRAPH_MESSAGE_MAX_BYTES = 150 * 1024 * 1024;
/** The largest raw RFC-822 message Gmail's `users.messages.send` accepts. */
export const GMAIL_RAW_MESSAGE_MAX_BYTES = 25 * 1024 * 1024;

export const MAIL_TRANSPORT_CAPABILITIES: Readonly<Record<MailTransportKind, MailTransportCapabilities>> = Object.freeze({
  // No universal SMTP limit exists: any server-side ceiling is a deployment fact this installation cannot
  // read, so the configured fallback applies and is documented as a fallback rather than as SMTP's limit.
  smtp: Object.freeze({
    kind: 'smtp',
    singleAttachmentBytes: null,
    messageBytes: null,
    rawMessageBytes: null,
    uploadSessionThresholdBytes: null,
    uploadSessionFileBytes: null,
  }),
  microsoft_graph: Object.freeze({
    kind: 'microsoft_graph',
    singleAttachmentBytes: GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
    messageBytes: GRAPH_MESSAGE_MAX_BYTES,
    rawMessageBytes: null,
    uploadSessionThresholdBytes: GRAPH_INLINE_ATTACHMENT_MAX_BYTES,
    uploadSessionFileBytes: GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
  }),
  gmail_api: Object.freeze({
    kind: 'gmail_api',
    // Gmail's own limit is on the raw message, so a single attachment is bounded by that same ceiling rather
    // than by a separate per-file number it does not publish.
    singleAttachmentBytes: GMAIL_RAW_MESSAGE_MAX_BYTES,
    messageBytes: GMAIL_RAW_MESSAGE_MAX_BYTES,
    rawMessageBytes: GMAIL_RAW_MESSAGE_MAX_BYTES,
    uploadSessionThresholdBytes: null,
    uploadSessionFileBytes: null,
  }),
});

export function mailTransportCapabilities(kind: MailTransportKind): MailTransportCapabilities {
  return MAIL_TRANSPORT_CAPABILITIES[kind];
}

/** The account fields this decision reads; the account row itself is carried through unchanged. */
export interface MailTransportAccountLike {
  mail_transport?: string | null;
}

/**
 * Which transport an account sends over.
 *
 * The same rule the send seam uses, stated once: a recorded native transport is that transport, and an
 * account with none is IMAP/SMTP — the only thing a pre-v4 row could have been. The limit model runs before
 * the seam binds the transport, so the two must not be allowed to disagree.
 */
export function transportKindForAccount(account: MailTransportAccountLike | null | undefined): MailTransportKind {
  if (account?.mail_transport === 'microsoft_graph') return 'microsoft_graph';
  if (account?.mail_transport === 'gmail_api') return 'gmail_api';
  return 'smtp';
}
