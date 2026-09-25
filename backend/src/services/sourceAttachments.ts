import { fetchGraphAttachmentBytes } from './providers/microsoft/graphMailBody.js';
import { fetchGmailAttachmentBytes } from './providers/google/gmailMailBody.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';

/**
 * A source account as this module needs it: which transport owns the message, and what that transport
 * needs to address it.
 */
export interface SourceAttachmentAccount {
  id: string;
  user_id: string;
  mail_transport?: string | null;
  provider_connection_id?: string | null;
}

export interface SourceAttachmentMessage {
  uid: number | string;
  folder: string;
  /** The provider's immutable message id, on a natively-ingested message. */
  provider_message_id?: string | null;
}

export interface SourceAttachmentRef {
  /** IMAP part number, or the provider's attachment id on a native message. */
  part: string;
  filename?: string | null;
}

/** The IMAP fetch, injected so this module never imports the mail manager (which would be a cycle). */
export type ImapAttachmentFetcher = (
  account: SourceAttachmentAccount,
  uid: number | string,
  folder: string,
  part: string,
) => Promise<Buffer | null>;

export class SourceAttachmentError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'SourceAttachmentError';
  }
}

/**
 * Fetch one attachment from the account that **owns the message it belongs to**.
 *
 * The dispatch is on the *source* account's transport, never on the account doing the sending: a forward
 * from an Outlook mailbox into a Gmail one must read the bytes from Outlook, and — the part that matters
 * most — a native Graph or Gmail message must never be fetched over IMAP. Before this, the send route
 * called `imapManager.fetchAttachment` unconditionally, so a forward whose source was a native account
 * would open an IMAP connection for a mailbox that has no IMAP session at all.
 *
 * A transport with no branch here fails explicitly rather than falling back to IMAP, so the gap is named
 * instead of silently mis-routed.
 */
export async function fetchSourceAttachment(input: {
  account: SourceAttachmentAccount;
  message: SourceAttachmentMessage;
  attachment: SourceAttachmentRef;
  imap: ImapAttachmentFetcher;
  /** Ceiling for the provider fetch; the caller enforces its own limits either way. */
  maxBytes?: number;
}): Promise<Buffer> {
  const { account, message, attachment, imap, maxBytes } = input;
  const transport = account.mail_transport ?? 'imap_smtp';

  if (transport === 'microsoft_graph') {
    if (!account.provider_connection_id) {
      throw new SourceAttachmentError('This message belongs to an account with no Microsoft connection', 409, 'PROVIDER_AUTH_REQUIRED');
    }
    if (!message.provider_message_id) {
      throw new SourceAttachmentError('This Microsoft message has no provider identity to read attachments from', 409, 'RESOURCE_NOT_FOUND');
    }
    const bytes = await fetchGraphAttachmentBytes(
      {
        userId: account.user_id,
        connectionId: account.provider_connection_id,
        config: microsoftConfigFromEnv(),
      },
      message.provider_message_id,
      attachment.part,
      maxBytes ?? Number.MAX_SAFE_INTEGER,
    );
    if (!bytes.length) {
      throw new SourceAttachmentError(`Could not fetch attachment: ${attachment.filename ?? attachment.part}`, 502, 'ATTACHMENT_FETCH_FAILED');
    }
    return bytes;
  }

  if (transport === 'gmail_api') {
    if (!account.provider_connection_id) {
      throw new SourceAttachmentError('This message belongs to an account with no Google connection', 409, 'PROVIDER_AUTH_REQUIRED');
    }
    if (!message.provider_message_id) {
      throw new SourceAttachmentError('This Gmail message has no provider identity to read attachments from', 409, 'RESOURCE_NOT_FOUND');
    }
    const bytes = await fetchGmailAttachmentBytes(
      {
        userId: account.user_id,
        connectionId: account.provider_connection_id,
        config: googleConfigFromEnv(),
      },
      message.provider_message_id,
      attachment.part,
      maxBytes ?? Number.MAX_SAFE_INTEGER,
    );
    if (!bytes.length) {
      throw new SourceAttachmentError(`Could not fetch attachment: ${attachment.filename ?? attachment.part}`, 502, 'ATTACHMENT_FETCH_FAILED');
    }
    return bytes;
  }

  if (transport !== 'imap_smtp') {
    // Named, not guessed: an unimplemented transport must not be served by the IMAP path.
    throw new SourceAttachmentError(
      `Forwarding from a ${transport} source is not supported yet`,
      501,
      'OPERATION_FORBIDDEN',
    );
  }

  const buffer = await imap(account, message.uid, message.folder, attachment.part);
  if (!buffer) {
    throw new SourceAttachmentError(`Could not fetch attachment: ${attachment.filename ?? attachment.part}`, 502, 'ATTACHMENT_FETCH_FAILED');
  }
  return buffer;
}
