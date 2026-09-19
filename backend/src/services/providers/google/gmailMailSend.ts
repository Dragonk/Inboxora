import { GMAIL_MAX_RAW_MESSAGE_BYTES, GMAIL_USER, gmailPost, toBase64Url } from './gmailApi.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';

/**
 * Gmail's send (P08, send slice).
 *
 * `users.messages.send` takes the message as a base64url RFC-822 buffer in `raw`, and **the Gmail API's
 * `Message` resource has no envelope field** — checked against the API discovery document, whose only
 * recipient-carrying fields are the headers themselves — while its own documentation says the send
 * delivers "to the recipients in the `To`, `Cc`, and `Bcc` headers". So the buffer this adapter posts
 * **keeps** the `Bcc:` header (see `renderGmailRawMessage`), because that is the only mechanism Gmail
 * offers for reaching a blind recipient: stripping it would silently drop every one of them, and posting
 * an `envelope` field would be an unknown field the API rejects or ignores.
 *
 * The privacy property is therefore Gmail's to keep, exactly as it is for any submission agent: the
 * provider derives the SMTP envelope from the headers and does not expose the `Bcc:` header on the copies
 * it delivers. That is stated here because it is a real difference from the SMTP arm, where this
 * installation removes the header itself.
 *
 * The outcome mapping is the same conservative one the Graph transport uses, because the trap is the same
 * and transport-independent: a provider answer read before acceptance is a refusal, and anything that
 * could have happened after the request left is `outcome_unknown`, which must never be retried
 * automatically.
 */

export interface GmailSendMessageResult {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
}

export type GmailSendOutcome =
  /** Gmail accepted the message for delivery. On a `200` nothing more can be learned from the answer. */
  | { status: 'accepted'; providerMessageId?: string }
  /**
   * Gmail answered and refused, before acceptance. `retryable` is the provider's own class: throttling
   * is worth another attempt, a permission or identity refusal is not.
   */
  | { status: 'refused'; httpStatus: number; code: string; message: string; retryable: boolean }
  /**
   * The outcome is **not known**: the request may or may not have reached Gmail. This is the one answer
   * that must never be treated as either success or failure, and it is never retried here.
   */
  | { status: 'outcome_unknown'; reason: string };

/**
 * Gmail's own ceiling on a message it will accept, measured on the **decoded** RFC-822 bytes.
 *
 * Gmail's `users.messages.send` also advertises a 35 MiB media-upload limit, which is a limit on the
 * upload encoding rather than on the message and is deliberately not used as one: the raw message
 * ceiling is the smaller, correct number, and base64url expansion of a message already at it would
 * otherwise look like an over-limit message.
 */
export function gmailMessageSizeRefusal(
  rawBytes: number,
  limitBytes: number = GMAIL_MAX_RAW_MESSAGE_BYTES,
): { code: string; actualBytes: number; limitBytes: number } | null {
  if (rawBytes <= limitBytes) return null;
  return { code: 'MESSAGE_TOO_LARGE', actualBytes: rawBytes, limitBytes };
}

/**
 * Send one already-rendered RFC-822 message.
 *
 * This is the non-idempotent step: the message leaves for its recipients once, and a lost response cannot
 * be repaired by asking again — asking again sends a second copy.
 */
export async function sendGmailRawMessage(
  api: GoogleApiOptions,
  raw: Buffer,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GmailSendOutcome> {
  const target: GoogleApiOptions = options.fetchImpl ? { ...api, fetchImpl: options.fetchImpl } : api;
  try {
    const sent = await gmailPost<GmailSendMessageResult>(target, `users/${GMAIL_USER}/messages/send`, {
      raw: toBase64Url(raw),
    });
    // An accepted send whose answer carried no id is still accepted: the message left, and inventing an
    // id would be a claim about the provider we do not have.
    return { status: 'accepted', ...(sent?.id ? { providerMessageId: sent.id } : {}) };
  } catch (caught) {
    if (caught instanceof GoogleApiError) {
      const status = caught.status ?? 0;
      if (status >= 400 && status < 500) {
        return {
          status: 'refused',
          httpStatus: status,
          code: caught.code ?? 'PROVIDER_REFUSED',
          message: caught.message,
          retryable: status === 429,
        };
      }
      // A 5xx could be a refusal or a lost dispatch, so it is reported as neither.
      return { status: 'outcome_unknown', reason: caught.message };
    }
    return { status: 'outcome_unknown', reason: caught instanceof Error ? caught.message : String(caught) };
  }
}
