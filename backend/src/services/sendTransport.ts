import { createAccountSmtpTransport } from './smtpTransport.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { graphMailTransport, type TransportSendResult } from './providers/microsoft/graphMailTransport.js';
import { gmailMailTransport } from './providers/google/gmailMailTransport.js';
import type { ComposedMail, RenderedSmtpMessage } from './composedMail.js';

export type { TransportSendResult };

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
   * Dispatch one already-claimed message.
   *
   * A transport that knows its own outcome semantics returns `accepted` / `refused` / `outcome_unknown`
   * (Graph). SMTP keeps its existing behaviour — a protocol failure is **thrown**, because only the
   * route's legacy classifier can tell a pre-DATA rejection from an indeterminate one — and a successful
   * hand-off is returned as `accepted` with nodemailer's recipient lists.
   */
  send(input: { composed: ComposedMail; rendered?: RenderedSmtpMessage }): Promise<TransportSendResult>;
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
    return {
      account,
      transport: {
        kind: 'microsoft_graph',
        sendsRenderedMessage: false,
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
    return {
      account,
      transport: {
        kind: 'gmail_api',
        sendsRenderedMessage: false,
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
