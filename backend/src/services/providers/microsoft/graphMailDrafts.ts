import { GraphApiError, graphPatch, type GraphApiOptions } from './graphApiClient.js';
import { createGraphDraft, renderGraphMessage } from './graphMailSend.js';
import { graphDeleteMessage } from './graphMailMutations.js';
import { providerUidForGraphMessage } from './graphMail.js';
import { query } from '../../db.js';
import type { ComposedMail } from '../../composedMail.js';

/**
 * Microsoft Graph **user drafts** (P07b): the message the compose window saves, not the staging draft a
 * send builds.
 *
 * A saved draft is the provider's object, exactly as it is on IMAP. Graph's advantage is that the saved
 * draft is the same `message` resource the send pipeline already knows how to create, patch, read and
 * delete, so the composer's draft and a real send share one representation — and, unlike MIME, Graph's
 * JSON keeps `bccRecipients` out of band, so a draft with a blind recipient keeps it across a reload and
 * across clients.
 *
 * Replacing a draft is a **PATCH of the same provider object** rather than create-then-delete: the
 * provider id survives, so there is no window in which two drafts exist and no identity change for the
 * local row. When the message moves to a different account, or the saved draft no longer exists at the
 * provider, a new draft is created and the old identity is reported as superseded so the caller can
 * remove it.
 */

export interface GraphDraftSave {
  /** The provider's own draft id — the identity that survives a replace. */
  id: string;
  /** True when the saved draft is a new provider object and a previous identity was superseded. */
  created: boolean;
  /** The provider draft that this save replaced, when it could not be updated in place. */
  supersededId?: string;
}

async function patchGraphDraft(
  api: GraphApiOptions,
  draftId: string,
  composed: ComposedMail,
): Promise<string | null> {
  try {
    const updated = await graphPatch<{ id?: string }>(
      api,
      `/me/messages/${encodeURIComponent(draftId)}`,
      renderGraphMessage(composed),
    );
    return updated?.id ?? draftId;
  } catch (caught) {
    // The saved draft was deleted at the provider (another client, or retention): a save must still
    // succeed, so this is reported as "create a new one" rather than as a failure. Every other failure
    // — throttling, a refusal, an authorization problem — propagates.
    if (caught instanceof GraphApiError && caught.code === 'RESOURCE_NOT_FOUND') return null;
    throw caught;
  }
}

/**
 * Create the saved draft, or update the one the composer already has.
 *
 * `existingDraftId` is the provider id held against the local row. A draft on a *different* account can
 * never be patched into this one, so the caller passes no id in that case and this creates a fresh draft.
 */
export async function saveGraphUserDraft(
  api: GraphApiOptions,
  composed: ComposedMail,
  options: { existingDraftId?: string | null } = {},
): Promise<GraphDraftSave> {
  const existing = options.existingDraftId ?? null;
  if (existing) {
    const patchedId = await patchGraphDraft(api, existing, composed);
    if (patchedId) return { id: patchedId, created: false };
    const createdDraft = await createGraphDraft(api, composed);
    return { id: createdDraft.id, created: true, supersededId: existing };
  }
  const createdDraft = await createGraphDraft(api, composed);
  return { id: createdDraft.id, created: true };
}

/**
 * Remove a saved draft.
 *
 * A draft that is already gone is the **end state the caller asked for**, so a `404` is not a failure:
 * the local row is still removed and the operation is reported as done. Any other provider refusal
 * propagates, because the local row must not be dropped while the provider still holds the draft.
 */
export async function deleteGraphUserDraft(api: GraphApiOptions, draftId: string): Promise<{ alreadyGone: boolean }> {
  try {
    await graphDeleteMessage(api, draftId);
    return { alreadyGone: false };
  } catch (caught) {
    if (caught instanceof GraphApiError && caught.code === 'RESOURCE_NOT_FOUND') return { alreadyGone: true };
    throw caught;
  }
}

export interface GraphDraftRecordInput {
  accountId: string;
  folder: string;
  providerDraftId: string;
  messageId: string;
  subject?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  to?: Array<{ name?: string | null; email: string }>;
  cc?: Array<{ name?: string | null; email: string }>;
  bcc?: Array<{ name?: string | null; email: string }>;
  aliasId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  snippet?: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  draftComposition?: Record<string, unknown> | null;
  date?: Date;
}

export interface GraphDraftRecord {
  /** The compatibility number the rest of the application addresses this draft by. */
  uid: string;
  rowId: string;
}

/**
 * Mirror a provider draft into the local `messages` table.
 *
 * The row is keyed by the **provider id** — the same partial unique index the message sync uses — and
 * carries the same derived `uid`, so a later delta sync updates this row instead of inserting a second
 * one. The draft columns the composer reopens with (`draft_composition`, `draft_bcc_addresses`,
 * `draft_alias_id`, the reply headers) are written here because nothing else will: the sync projects
 * message metadata, not composition state.
 */
export async function upsertGraphDraftRecord(input: GraphDraftRecordInput): Promise<GraphDraftRecord> {
  const uid = providerUidForGraphMessage(input.providerDraftId);
  const result = await query<{ id: string; uid: string }>(
    `INSERT INTO messages (
       account_id, uid, folder, provider_message_id, message_id, subject,
       from_name, from_email, to_addresses, cc_addresses, in_reply_to, date, snippet,
       is_read, is_starred, has_attachments, flags, body_html, body_text, thread_id,
       draft_bcc_addresses, draft_alias_id, draft_in_reply_to, draft_references, draft_composition,
       synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,
       true,false,false,$14::jsonb,$15,$16,$17,
       $18::jsonb,$19,$20,$21,$22::jsonb,
       NOW()
     )
     ON CONFLICT (account_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO UPDATE SET
       folder = EXCLUDED.folder,
       message_id = EXCLUDED.message_id,
       subject = EXCLUDED.subject,
       from_name = EXCLUDED.from_name,
       from_email = EXCLUDED.from_email,
       to_addresses = EXCLUDED.to_addresses,
       cc_addresses = EXCLUDED.cc_addresses,
       in_reply_to = EXCLUDED.in_reply_to,
       date = EXCLUDED.date,
       snippet = EXCLUDED.snippet,
       flags = EXCLUDED.flags,
       body_html = EXCLUDED.body_html,
       body_text = EXCLUDED.body_text,
       thread_id = EXCLUDED.thread_id,
       draft_bcc_addresses = EXCLUDED.draft_bcc_addresses,
       draft_alias_id = EXCLUDED.draft_alias_id,
       draft_in_reply_to = EXCLUDED.draft_in_reply_to,
       draft_references = EXCLUDED.draft_references,
       draft_composition = EXCLUDED.draft_composition,
       synced_at = NOW()
     RETURNING id, uid::text AS uid`,
    [
      input.accountId, uid, input.folder, input.providerDraftId, input.messageId,
      input.subject || '(no subject)',
      input.fromName ?? '', input.fromEmail ?? '',
      JSON.stringify(input.to ?? []), JSON.stringify(input.cc ?? []),
      input.inReplyTo ?? null, input.date ?? new Date(), input.snippet ?? '',
      JSON.stringify(['\\Draft', '\\Seen']),
      input.bodyHtml ?? null, input.bodyText ?? null,
      input.messageId || null,
      JSON.stringify(input.bcc ?? []),
      input.aliasId ?? null,
      input.inReplyTo ?? null,
      input.references ?? null,
      input.draftComposition ? JSON.stringify(input.draftComposition) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('The saved draft could not be recorded locally');
  return { uid: String(row.uid), rowId: row.id };
}

/** The provider draft id a local row holds, if it is a draft this account owns. */
export async function graphDraftIdForLocalRow(accountId: string, uid: string | number, folder: string): Promise<string | null> {
  const result = await query<{ provider_message_id: string | null }>(
    'SELECT provider_message_id FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [accountId, String(uid), folder],
  );
  return result.rows[0]?.provider_message_id ?? null;
}
