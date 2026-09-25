import { GraphApiError, graphPatch, graphPost, type GraphApiOptions } from './graphApiClient.js';
import type { ComposedMail, Mailbox } from '../../composedMail.js';

/**
 * Microsoft Graph's representation of a message — the renderer's output for this transport.
 *
 * It exists instead of a MIME posting helper for one decisive reason: **Graph's JSON message is the
 * shape that can carry a blind recipient out of band**, as `bccRecipients`. The MIME form puts every
 * recipient in the Internet message headers, and Inboxora's composed artefact deliberately has no
 * `Bcc:` header (so that a buffer sent as `raw` over SMTP cannot disclose one), so posting MIME would
 * either lose the blind recipient or expose it. This pipeline is draft-first for that reason, and for
 * every message size — a second, MIME-shaped path for small messages would mean two outcome semantics
 * and two Bcc behaviours.
 */
export interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

export interface GraphMessagePayload {
  subject: string;
  body: { contentType: 'HTML' | 'Text'; content: string };
  /**
   * The identity the message is sent as.
   *
   * Graph sends as the mailbox's primary address unless this is set, so a user who picked an alias would have
   * their mail arrive from the primary identity — the alias would appear to work in the composer and silently
   * not on the wire. It is always set to the sender the caller chose; if the mailbox may not send as it, Graph
   * answers `ErrorSendAsDenied` and the send fails visibly rather than being retried from the primary address.
   */
  from: GraphRecipient;
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  bccRecipients: GraphRecipient[];
  replyTo?: GraphRecipient[];
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  /**
   * The message's importance, from the shared `ComposedMail.priority`.
   *
   * Without this the composer's choice was silently dropped on the Graph transport (MAIL-04): the SMTP renderer
   * mapped it, Graph did not, and the recipient saw a normal-priority message whatever the user picked.
   */
  importance?: 'low' | 'normal' | 'high';
}

const toRecipients = (mailboxes: readonly Mailbox[]): GraphRecipient[] =>
  mailboxes.map(mailbox => ({
    emailAddress: {
      address: mailbox.email,
      // Separate fields, because that is the semantic mapping: `address` holds an address and never a
      // display-name string, and `name` is present only when the caller provided one.
      ...(mailbox.name ? { name: mailbox.name } : {}),
    },
  }));

/**
 * Render the canonical model into Graph's message JSON.
 *
 * The three recipient groups are mapped **separately** — never merged, never inferred from a header —
 * which is what keeps a blind recipient blind on this transport. `In-Reply-To` and `References` become
 * Internet message headers, because Graph has no dedicated field for them, and the caller's own safe
 * headers pass through alongside.
 */
export function renderGraphMessage(composed: ComposedMail): GraphMessagePayload {
  const headers: Array<{ name: string; value: string }> = [];
  // `In-Reply-To` and `References` are deliberately **not** put here. Graph's JSON contract only accepts custom
  // internet headers whose name starts with `x-`, so the two RFC headers were not honoured — the provider's own
  // `createReply`/`createReplyAll`/`createForward` is what creates the threading edge (MAIL-03). The shared
  // composer still carries them, and the SMTP and Gmail transports still send them.
  for (const [name, value] of Object.entries(composed.headers ?? {})) {
    headers.push({ name, value });
  }

  const payload: GraphMessagePayload = {
    subject: composed.subject,
    body: composed.htmlBody
      ? { contentType: 'HTML', content: composed.htmlBody }
      : { contentType: 'Text', content: composed.plainBody },
    // The chosen identity, not the mailbox's primary address and not merely its display name: an alias is an
    // address, and Graph decides who the message is from by this field.
    from: toRecipients([composed.from])[0],
    toRecipients: toRecipients(composed.to),
    ccRecipients: toRecipients(composed.cc),
    bccRecipients: toRecipients(composed.bcc),
  };
  if (composed.replyTo) payload.replyTo = toRecipients([composed.replyTo]);
  // `low`/`normal`/`high` are Graph's own documented values, so the shared model maps across unchanged.
  if (composed.priority) payload.importance = composed.priority;
  if (headers.length) payload.internetMessageHeaders = headers;
  return payload;
}

export interface GraphDraft {
  id: string;
}

/**
 * Create the provider draft this message will be sent from.
 *
 * Deliberately not a send: the pipeline adds the attachments to this draft and only then posts
 * `/me/messages/{id}/send`, so there is a provider-side object to resume from, to preserve on failure,
 * and to reconcile an unknown outcome against. The returned id is the provider's own, and the caller
 * records it against the send intent.
 */
export async function createGraphDraft(api: GraphApiOptions, composed: ComposedMail): Promise<GraphDraft> {
  const created = await graphPost<GraphDraft>(api, '/me/messages', renderGraphMessage(composed));
  if (!created?.id) {
    // A create that answers without an id cannot be resumed, so it is not reported as success.
    throw new Error('Microsoft Graph did not return a draft id');
  }
  return created;
}

/**
 * Create the provider's own reply/forward draft from the answered message.
 *
 * Graph's `createReply`/`createReplyAll`/`createForward` is what establishes the provider-side threading edge;
 * the RFC `In-Reply-To`/`References` headers cannot be set through the JSON payload at all (a custom header must
 * start with `x-`), so a JSON "reply" built as a new message has no relationship the provider recognises
 * (MAIL-03). The draft is patched with the composed content afterwards.
 */
export async function createGraphReplyDraft(
  api: GraphApiOptions,
  providerMessageId: string,
  kind: 'reply' | 'reply_all' | 'forward',
): Promise<GraphDraft> {
  const action = kind === 'reply_all' ? 'createReplyAll' : kind === 'forward' ? 'createForward' : 'createReply';
  const created = await graphPost<GraphDraft>(
    api,
    `/me/messages/${encodeURIComponent(providerMessageId)}/${action}`,
    {},
  );
  if (!created?.id) {
    // A create that answers without an id cannot be resumed, so it is not reported as success.
    throw new Error('Microsoft Graph did not return a reply draft id');
  }
  return created;
}

/** Replace the draft's content with the composed message, keeping the provider's own threading. */
export async function patchGraphDraft(api: GraphApiOptions, draftId: string, composed: ComposedMail): Promise<void> {
  await graphPatch(api, `/me/messages/${encodeURIComponent(draftId)}`, renderGraphMessage(composed));
}

export type GraphSendResult =
  /** The provider accepted the send. On Graph that is a `202`, and nothing more can be learned from it. */
  | { status: 'accepted' }
  /**
   * The provider answered and refused, before acceptance. `retryable` is the provider's own class:
   * throttling and its 5xx are worth another attempt, a permission or identity refusal is not.
   */
  | { status: 'refused'; httpStatus: number; code: string; message: string; retryable: boolean }
  /**
   * The outcome is **not known**: the request may or may not have reached the provider. This is the one
   * answer that must never be treated as either success or failure, and it is never retried here.
   */
  | { status: 'outcome_unknown'; reason: string };

/**
 * Send the completed staging draft.
 *
 * This is the non-idempotent step: the message leaves for its recipients once, and a lost response cannot
 * be repaired by asking again — asking again sends a second copy. The mapping is therefore conservative:
 * a provider answer that refused the send is `refused` with the provider's own class, and anything that
 * could have happened after the request left — a timeout, a connection loss, a 5xx with no body — is
 * `outcome_unknown`, which the caller parks as `send_outcome_unknown` and never re-runs automatically.
 *
 * There is deliberately **no** fallback to another transport here. A send whose outcome is uncertain must
 * not be re-attempted over SMTP: that is a cross-transport duplicate, not a recovery.
 */
export async function sendGraphDraft(
  api: GraphApiOptions,
  draftId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GraphSendResult> {
  const target: GraphApiOptions = options.fetchImpl ? { ...api, fetchImpl: options.fetchImpl } : api;
  try {
    await graphPost(target, `/me/messages/${encodeURIComponent(draftId)}/send`, {});
    return { status: 'accepted' };
  } catch (caught) {
    if (caught instanceof GraphApiError) {
      const status = caught.status ?? 0;
      // A provider answer we could read: the send was refused rather than accepted.
      if (status >= 400 && status < 500) {
        return {
          status: 'refused',
          httpStatus: status,
          code: caught.code ?? 'PROVIDER_REFUSED',
          message: caught.message,
          retryable: status === 429,
        };
      }
      // A 5xx could be a refusal or a lost dispatch, so it is not reported as either.
      return { status: 'outcome_unknown', reason: caught.message };
    }
    return { status: 'outcome_unknown', reason: caught instanceof Error ? caught.message : String(caught) };
  }
}
