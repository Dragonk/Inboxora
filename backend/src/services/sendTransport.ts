import { createAccountSmtpTransport } from './smtpTransport.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { graphMailTransport, type TransportSendResult } from './providers/microsoft/graphMailTransport.js';
import { gmailMailTransport } from './providers/google/gmailMailTransport.js';
import {
  attachmentRefusal,
  attachmentsRefusal,
  effectiveSendLimits,
  providerRawMessageRefusal,
  providerUploadFileRefusal,
  sendLimitRefusalMessage,
  type EffectiveSendLimits,
  type SendLimitRefusal,
} from './sendLimits.js';
import type { ComposedMail, RenderedSmtpMessage } from './composedMail.js';

export type { TransportSendResult };
// The limit model decides the transport from the account row; re-exported so the route uses one rule.
export { transportKindForAccount } from './providers/mailCapabilities.js';

/**
 * A refusal a transport reached **before dispatch**, in its own terms.
 *
 * It is a `SendLimitRefusal` plus the HTTP status and the sentence, so the route can answer with the domain
 * facts and a readable message without re-deriving either. Nothing has left the process when one exists.
 */
export interface TransportPreflightRefusal extends SendLimitRefusal {
  statusCode: number;
  error: string;
}

function preflightRefusal(refusal: SendLimitRefusal | null): TransportPreflightRefusal | null {
  if (!refusal) return null;
  return { ...refusal, statusCode: 413, error: sendLimitRefusalMessage(refusal) };
}

/**
 * Every attachment of a composed message, as decoded bytes with its name — the accounting the transports and
 * the route share, so a provider preflight and the installation's guard cannot disagree about the total.
 */
function composedAttachmentBytes(composed: ComposedMail): Array<{ filename: string; bytes: number }> {
  return (composed.attachments ?? []).map(attachment => ({
    filename: attachment.filename,
    bytes: Buffer.isBuffer(attachment.content) ? attachment.content.length : 0,
  }));
}


/**
 * The checks a transport can make in its own terms before anything is dispatched.
 *
 * SMTP returns null: its ceiling is measured by the route on the rendered RFC-822 message, which is what SMTP
 * actually sends, and a second opinion here would be the same number written twice.
 */
export function providerPreflight(kind: 'microsoft_graph' | 'gmail_api', limits: EffectiveSendLimits): (composed: ComposedMail) => TransportPreflightRefusal | null {
  return composed => {
    const attachments = composedAttachmentBytes(composed);
    if (kind === 'microsoft_graph') {
      for (const attachment of attachments) {
        // The provider's own upload ceiling is asked first so that a file the *provider* cannot take is named as
        // such; a file inside it but above a lowered installation ceiling is then named as the installation's
        // refusal, which is the distinction an operator needs to tell the two apart.
        const tooLarge = preflightRefusal(providerUploadFileRefusal(attachment.bytes, limits, attachment.filename))
          ?? preflightRefusal(attachmentRefusal(attachment.bytes, limits, attachment.filename));
        if (tooLarge) return tooLarge;
      }
      const total = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
      return preflightRefusal(attachmentsRefusal(total, limits));
    }
    return null;
  };
}

/** The Gmail preflight is async because it renders the raw message it will post — the only place that number exists. */
export async function gmailPreflight(composed: ComposedMail, limits: EffectiveSendLimits, render: () => Promise<Buffer>): Promise<{ refusal: TransportPreflightRefusal | null; raw?: Buffer }> {
  const attachments = composedAttachmentBytes(composed);
  for (const attachment of attachments) {
    const tooLarge = preflightRefusal(attachmentRefusal(attachment.bytes, limits, attachment.filename));
    if (tooLarge) return { refusal: tooLarge };
  }
  const total = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  const totalRefusal = preflightRefusal(attachmentsRefusal(total, limits));
  if (totalRefusal) return { refusal: totalRefusal };

  let raw: Buffer;
  try {
    raw = await render();
  } catch {
    // A composition failure is not a size problem: `send` reports it as the retryable refusal it is, with the
    // code it already uses, rather than being mislabelled as a limit here.
    return { refusal: null };
  }
  const refusal = preflightRefusal(providerRawMessageRefusal(raw.length, limits));
  // On a refusal the render is dropped rather than kept: nothing will be sent, so holding a message-sized
  // buffer for the life of the request would be memory kept for an answer that has already been given.
  return refusal ? { refusal } : { refusal: null, raw };
}

/**
 * The one place a send is bound to a transport, and the contract every transport answers.
 *
 * The route used to reach `createAccountSmtpTransport` directly, which made "how mail leaves this
 * installation" an SMTP question by construction. It is not one: a Microsoft Graph account sends over
 * Graph. Binding the route to this seam means the Graph branch is a branch **here** rather than a second
 * pipeline inside the send route, and the route no longer knows which transports exist.
 *
 * The contract carries the canonical `ComposedMail` model, not only nodemailer's options and the composed
 * MIME. That is what makes Graph representable on the same seam: blind recipients live in `composed.bcc`
 * as data, and a transport that expresses them out of band (Graph's `bccRecipients`) can render them,
 * while SMTP renders only what its wire format permits — the display form in the headers and addresses
 * only in the envelope.
 *
 * `sendsRenderedMessage` is the one capability the route needs before dispatch. SMTP sends the RFC-822
 * message the route renders, and that render is also what the message-size ceiling is measured on; a
 * transport that composes its own representation (Graph) is handed the model and nothing else, so no
 * SMTP render is performed — and no SMTP object is touched — for a native account.
 *
 * Nothing else about the send path moves. The `delivered` flag, the intent claim and the
 * uncertain-outcome handling stay where they are, which is what makes this a wrap: the boundary that
 * decides whether an outcome is knowable is already correct, and the transport only has to be pluggable
 * *behind* it.
 */
export interface MailTransport {
  kind: 'smtp' | 'microsoft_graph' | 'gmail_api';
  /** True when the route's rendered RFC-822 message is what this transport dispatches. */
  readonly sendsRenderedMessage: boolean;
  /**
   * A deterministic size check in the transport's own terms, run **before** the send intent is claimed.
   *
   * A provider that refuses a message it cannot carry does so here rather than after dispatch, where the same
   * answer would be indistinguishable from a lost response and would have to be parked as an unknown outcome.
   * A transport with nothing extra to measure omits it (SMTP measures the route's rendered message).
   */
  preflight?(composed: ComposedMail): Promise<TransportPreflightRefusal | null>;
  /**
   * Dispatch one already-claimed message.
   *
   * A transport that knows its own outcome semantics returns `accepted` / `refused` / `outcome_unknown`
   * (Graph). SMTP keeps its existing behaviour — a protocol failure is **thrown**, because only the
   * route's legacy classifier can tell a pre-DATA rejection from an indeterminate one — and a successful
   * hand-off is returned as `accepted` with nodemailer's recipient lists.
   */
  send(input: { composed: ComposedMail; rendered?: RenderedSmtpMessage; replyContext?: ReplyContext }): Promise<TransportSendResult>;
}

/**
 * The message a send answers, when the answer must be created **as** a reply at the provider.
 *
 * Graph rejects the RFC `In-Reply-To`/`References` headers in its JSON payload (a custom internet header must
 * start with `x-`), and the provider's own `createReply`/`createReplyAll`/`createForward` action is what gives
 * the message its threading edge (MAIL-03). `providerMessageId` is the answered message's id in the **same
 * mailbox**; a reply to a message that lives in another mailbox is not modelled as a provider reply.
 */
export interface ReplyContext {
  kind: 'reply' | 'reply_all' | 'forward';
  providerMessageId: string;
}

/** The account fields this seam reads to choose a transport; the row itself is carried through. */
type MailTransportAccount = Parameters<typeof createAccountSmtpTransport>[0] & {
  user_id?: string;
  mail_transport?: string | null;
  provider_connection_id?: string | null;
};

const asStringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** The refusal-to-bind shape the route answers with, before any dispatch happens. */
export type MailTransportFailure = { status: number; error: string; code?: string };

export type MailTransportBinding<Account> =
  | MailTransportFailure
  | { account: Account; transport: MailTransport };

/**
 * Read a failure out of whatever the SMTP factory returned, without asserting its shape: the factory's
 * union is inferred from several return sites, and this is the one place that needs a single error form.
 */
function smtpFailure(value: unknown): MailTransportFailure | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { status?: unknown; error?: unknown; code?: unknown };
  if (typeof candidate.error !== 'string') return null;
  return {
    status: typeof candidate.status === 'number' ? candidate.status : 502,
    error: candidate.error,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
  };
}

export async function createAccountMailTransport<Account extends MailTransportAccount>(
  account: Account,
): Promise<MailTransportBinding<Account>> {
  // The Graph branch belongs exactly here. The account type is carried through rather than widened, so
  // the route keeps the row it passed in.
  if (account.mail_transport === 'microsoft_graph') {
    if (!account.provider_connection_id) {
      // A native account without its connection cannot be sent from, and that is an authorization state
      // to fix rather than a transient failure to retry.
      return {
        status: 409,
        code: 'PROVIDER_AUTH_REQUIRED',
        error: 'This account is not linked to a Microsoft connection. Reconnect the account to send mail.',
      };
    }
    const api = {
      userId: account.user_id ?? '',
      connectionId: account.provider_connection_id,
      config: microsoftConfigFromEnv(),
    };
    const graph = graphMailTransport(api);
    const limits = effectiveSendLimits('microsoft_graph');
    const preflight = providerPreflight('microsoft_graph', limits);
    return {
      account,
      transport: {
        kind: 'microsoft_graph',
        sendsRenderedMessage: false,
        async preflight(composed) { return preflight(composed); },
        send: (input: { composed: ComposedMail }) => graph.send(input),
      },
    };
  }

  // The Gmail branch belongs here too, for the same reason the Graph one does: binding a native account to
  // its provider is the seam's job, and the route must not learn which transports exist.
  if (account.mail_transport === 'gmail_api') {
    if (!account.provider_connection_id) {
      return {
        status: 409,
        code: 'PROVIDER_AUTH_REQUIRED',
        error: 'This account is not linked to a Google connection. Reconnect the account to send mail.',
      };
    }
    const gmail = gmailMailTransport({
      userId: account.user_id ?? '',
      connectionId: account.provider_connection_id,
      config: googleConfigFromEnv(),
    });
    const limits = effectiveSendLimits('gmail_api');
    return {
      account,
      transport: {
        kind: 'gmail_api',
        sendsRenderedMessage: false,
        async preflight(composed) {
          // The render the preflight needs is also the render `send` posts, so the transport keeps it: one
          // composition, measured once, dispatched once.
          const { refusal, raw } = await gmailPreflight(composed, limits, () => gmail.render(composed));
          if (raw) gmail.rememberRaw(raw);
          return refusal;
        },
        send: (input: { composed: ComposedMail }) => gmail.send(input),
      },
    };
  }

  const smtp = await createAccountSmtpTransport(account);
  const failure = smtpFailure(smtp);
  if (failure) return failure;
  const smtpAccount: Account = ('account' in smtp ? smtp.account : undefined) ?? account;
  const smtpTransport = 'transport' in smtp ? smtp.transport : undefined;
  if (!smtpTransport) throw new Error('SMTP transport is unavailable');
  const transport: MailTransport = {
    kind: 'smtp',
    sendsRenderedMessage: true,
    async send({ rendered }) {
      if (!rendered) throw new Error('The SMTP transport requires the rendered message');
      // Hand over the message composed for the accounting instead of letting the transport compose a
      // second one: a pre-composed buffer delivered through `raw` is byte-identical, and the buffer
      // carries no `Bcc:` header, which is what makes it safe to send verbatim.
      const info = await smtpTransport.sendMail({ ...rendered.mailOptions, raw: rendered.raw });
      return {
        status: 'accepted',
        accepted: asStringList(info.accepted),
        rejected: asStringList(info.rejected),
      };
    },
  };
  return { account: smtpAccount, transport };
}
