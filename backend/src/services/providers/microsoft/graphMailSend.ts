import { graphPost, type GraphApiOptions } from './graphApiClient.js';
import type { ComposedMail } from '../../composedMail.js';

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
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  bccRecipients: GraphRecipient[];
  replyTo?: GraphRecipient[];
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

const toRecipients = (addresses: readonly string[]): GraphRecipient[] =>
  addresses.map(address => ({ emailAddress: { address } }));

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
  if (composed.inReplyTo) headers.push({ name: 'In-Reply-To', value: composed.inReplyTo });
  if (composed.references) headers.push({ name: 'References', value: composed.references });
  for (const [name, value] of Object.entries(composed.headers ?? {})) {
    // A caller-supplied header must not shadow the two the message's own threading depends on.
    if (headers.some(header => header.name.toLowerCase() === name.toLowerCase())) continue;
    headers.push({ name, value });
  }

  const payload: GraphMessagePayload = {
    subject: composed.subject,
    body: composed.htmlBody
      ? { contentType: 'HTML', content: composed.htmlBody }
      : { contentType: 'Text', content: composed.plainBody },
    toRecipients: toRecipients(composed.to),
    ccRecipients: toRecipients(composed.cc),
    bccRecipients: toRecipients(composed.bcc),
  };
  if (composed.replyTo) payload.replyTo = toRecipients([composed.replyTo.email]);
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
