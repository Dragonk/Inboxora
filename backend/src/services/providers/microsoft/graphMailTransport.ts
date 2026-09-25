import { createGraphDraft, createGraphReplyDraft, patchGraphDraft, sendGraphDraft } from './graphMailSend.js';
import { addGraphAttachment } from './graphMailAttachments.js';
import type { GraphApiOptions } from './graphApiClient.js';
import type { ReplyContext } from '../../sendTransport.js';
import type { ComposedMail } from '../../composedMail.js';

/**
 * The transport answers a caller must be able to tell apart. Only two of them can be acted on: an unknown
 * outcome must be parked and never retried, and a refusal is a fact the user can be told.
 */
export type TransportSendResult =
  | { status: 'accepted'; accepted: string[]; rejected: string[]; providerMessageId?: string }
  | { status: 'refused'; statusCode: number; code: string; error: string; retryable: boolean }
  | { status: 'outcome_unknown'; reason: string };

/** The Graph API context one account's sends use. */
export interface GraphTransportApi {
  userId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
}

/**
 * Microsoft Graph's send transport: **draft-first, one path for every message size**.
 *
 * Create the draft as Graph JSON so `bccRecipients` carries blind recipients out of band, add every
 * attachment to that draft (direct below the 3 MB method threshold, through an upload session above it),
 * and only then send it. A second, MIME-shaped path for small messages would mean two outcome semantics
 * and two Bcc behaviours, which is why there is one.
 *
 * Nothing here can reach SMTP, and a send whose outcome is unknown is reported as unknown rather than
 * retried — over Graph or anywhere else. A failure **before** the final send is a staging failure, not an
 * unknown send: no message has left for the recipients, so it is reported as a retryable refusal.
 */
export function graphMailTransport(api: GraphTransportApi) {
  return {
    kind: 'microsoft_graph' as const,
    async send(input: { composed: ComposedMail; replyContext?: ReplyContext }): Promise<TransportSendResult> {
      let draftId: string | null = null;
      try {
        // A reply or forward is staged with the provider's own action so the message carries the threading edge
        // Graph recognises, and then patched with the composed content. Without the context the draft is a new
        // message, which is what a reply to a message in **another** mailbox honestly is (MAIL-03).
        const graphReply = input.replyContext?.transport === 'microsoft_graph'
          ? input.replyContext
          : null;
        const draft = graphReply
          ? await createGraphReplyDraft(api, graphReply.providerMessageId, graphReply.kind)
          : await createGraphDraft(api, input.composed);
        draftId = draft.id;
        if (graphReply) await patchGraphDraft(api, draft.id, input.composed);
        for (const attachment of input.composed.attachments ?? []) {
          await addGraphAttachment(api, draft.id, attachment);
        }
        const sent = await sendGraphDraft(api, draft.id);
        if (sent.status === 'accepted') {
          return {
            status: 'accepted',
            accepted: [...input.composed.to, ...input.composed.cc, ...input.composed.bcc].map(mailbox => mailbox.email),
            rejected: [],
            providerMessageId: draft.id,
          };
        }
        if (sent.status === 'refused') {
          return { status: 'refused', statusCode: sent.httpStatus, code: sent.code, error: sent.message, retryable: sent.retryable };
        }
        return { status: 'outcome_unknown', reason: sent.reason };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const code = draftId === null ? 'DRAFT_CREATE_FAILED' : 'ATTACHMENT_UPLOAD_FAILED';
        // Both are before the final send, so nothing has left for the recipients: retryable, not unknown.
        return { status: 'refused', statusCode: 502, code, error: message, retryable: true };
      }
    },
  };
}
