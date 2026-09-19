import { renderGmailRawMessage } from '../../composedMail.js';
import type { ComposedMail } from '../../composedMail.js';
import { gmailMessageSizeRefusal, sendGmailRawMessage } from './gmailMailSend.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import type { TransportSendResult } from '../microsoft/graphMailTransport.js';

/**
 * Gmail API's send transport.
 *
 * The result vocabulary is imported rather than redeclared: `TransportSendResult` is the send seam's own
 * contract (`services/sendTransport.ts` re-exports it as such; it happens to be declared beside the Graph
 * transport, which was its first implementation), and a second, structurally identical copy here would be
 * free to drift out of the union the route switches on.
 *
 * The transport composes its **own** representation from the canonical model, so `sendsRenderedMessage` is
 * false for it: no SMTP message is built, no IMAP session is opened, and the route performs neither the
 * SMTP size accounting nor the Sent-folder APPEND. The size ceiling Gmail actually enforces is a provider
 * number, and it is checked here in the provider's terms — on the decoded RFC-822 bytes — before anything
 * is dispatched, so an over-limit message is a refusal the user can act on rather than an ambiguous
 * outcome.
 */
export interface GmailTransportApi {
  userId: string;
  connectionId: string;
  config: GoogleApiOptions['config'];
}

export function gmailMailTransport(api: GmailTransportApi) {
  /**
   * The render the seam measured, kept so the send that follows composes the message once.
   *
   * The transport instance is per request (the seam builds it for one account), so this is a single-use cache
   * rather than shared state, and it is cleared by the send that uses it.
   */
  let measuredRaw: Buffer | null = null;
  return {
    kind: 'gmail_api' as const,
    /** Render the raw message this transport would post. */
    render: (composed: ComposedMail) => renderGmailRawMessage(composed),
    /** Keep the render a preflight measured, for the send that follows. */
    rememberRaw: (raw: Buffer) => { measuredRaw = raw; },
    async send(input: { composed: ComposedMail }): Promise<TransportSendResult> {
      let raw: Buffer;
      try {
        raw = measuredRaw ?? await renderGmailRawMessage(input.composed);
      } catch (caught) {
        // Composing failed before anything left: retryable, not unknown.
        return {
          status: 'refused',
          statusCode: 500,
          code: 'MESSAGE_RENDER_FAILED',
          error: caught instanceof Error ? caught.message : String(caught),
          retryable: true,
        };
      }

      // Measure once: the preflight already measured this exact buffer when it ran.
      measuredRaw = null;
      const refusal = gmailMessageSizeRefusal(raw.length);
      if (refusal) {
        return {
          status: 'refused',
          statusCode: 413,
          code: refusal.code,
          error: `The composed message is ${refusal.actualBytes} bytes, above Gmail's ${refusal.limitBytes}-byte limit.`,
          retryable: false,
        };
      }

      const sent = await sendGmailRawMessage(api, raw);
      if (sent.status === 'accepted') {
        return {
          status: 'accepted',
          // Every recipient is reported as accepted: Gmail's answer is one `200` for the whole message,
          // and it carries no per-recipient verdict to report instead.
          accepted: [...input.composed.to, ...input.composed.cc, ...input.composed.bcc].map(mailbox => mailbox.email),
          rejected: [],
          ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}),
        };
      }
      if (sent.status === 'refused') {
        return { status: 'refused', statusCode: sent.httpStatus, code: sent.code, error: sent.message, retryable: sent.retryable };
      }
      return { status: 'outcome_unknown', reason: sent.reason };
    },
  };
}
