import { GMAIL_USER, gmailDelete, gmailGet, gmailPost, gmailPut, toBase64Url } from './gmailApi.js';
import { GoogleApiError } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { renderGmailRawMessage } from '../../composedMail.js';
import type { ComposedMail } from '../../composedMail.js';
import { providerUidForGmailMessage } from './gmailMail.js';
import { query } from '../../db.js';

/**
 * Gmail **user drafts** (P08, drafts slice): the message the compose window saves,
 * not the staging draft a send builds.
 *
 * A saved draft is the provider's own object, exactly as it is on IMAP and on Graph.
 * Gmail's draft **wraps** a message: the `Draft` resource has its own immutable `id`
 * and a `message` that is an ordinary message with its own id, and the two are
 * different values. That has one consequence this adapter must not get wrong:
 *
 *  - the local row is keyed on the **message** id, because that is what the message
 *    sync reconciles on and what `messages_provider_identity_key` makes unique. A row
 *    keyed on the draft id would be a second row for the same message as soon as the
 *    sync listed the Drafts label;
 *  - patching or deleting the draft therefore needs the **draft** id, which the local
 *    row does not carry (there is no column for it, and `0111` is the last migration
 *    this package may add). It is resolved from the provider instead, through a
 *    bounded `drafts.list` lookup by message id: the honest alternative to storing a
 *    second identity in a column whose meaning is something else.
 *
 * The draft's bytes are the canonical model rendered with its `Bcc:` header intact
 * (the same render the Gmail send uses). A draft is not delivered, so keeping the
 * header is what makes the blind recipient survive a reload — and it is what Gmail's
 * own drafts do.
 */

export interface GmailDraftSave {
  /** The provider's own draft id — the identity that survives a replace. */
  id: string;
  /** The provider's message id, which is what the local row is keyed on. */
  messageId: string;
  /** The thread the draft belongs to, for the local row's thread identity. */
  threadId: string | null;
  /** True when the saved draft is a new provider object and a previous identity was superseded. */
  created: boolean;
  /** The provider draft that this save replaced, when it could not be updated in place. */
  supersededId?: string;
}

interface DraftResponse {
  id?: string | null;
  message?: { id?: string | null; threadId?: string | null } | null;
}

function draftSaveFromResponse(response: DraftResponse | null, fallbackDraftId?: string): GmailDraftSave | null {
  const draftId = response?.id ?? fallbackDraftId;
  const messageId = response?.message?.id;
  if (!draftId || !messageId) return null;
  return {
    id: draftId,
    messageId,
    threadId: response?.message?.threadId ?? null,
    created: fallbackDraftId === undefined,
  };
}

/** Create the provider draft for one composed message. */
export async function createGmailDraft(
  api: GoogleApiOptions,
  composed: ComposedMail,
  options: { threadId?: string | null } = {},
): Promise<GmailDraftSave> {
  const raw = await renderGmailRawMessage(composed);
  const threadId = typeof options.threadId === 'string' && options.threadId.trim()
    ? options.threadId.trim()
    : null;
  const created = await gmailPost<DraftResponse>(api, `users/${GMAIL_USER}/drafts`, {
    message: { raw: toBase64Url(raw), ...(threadId ? { threadId } : {}) },
  });
  const save = draftSaveFromResponse(created);
  if (!save) {
    // A create that answers without the two ids cannot be addressed or reconciled
    // afterwards, so it is not reported as success.
    throw new Error('Gmail did not return a draft id');
  }
  return save;
}

/**
 * Update the saved draft in place.
 *
 * `null` means the draft no longer exists at the provider (another client, or
 * retention): a save must still succeed, so the caller creates a new one and reports
 * the old identity as superseded. Every other failure — throttling, a refusal, an
 * authorization problem — propagates.
 */
async function updateGmailDraft(
  api: GoogleApiOptions,
  draftId: string,
  composed: ComposedMail,
  options: { threadId?: string | null } = {},
): Promise<GmailDraftSave | null> {
  const raw = await renderGmailRawMessage(composed);
  const threadId = typeof options.threadId === 'string' && options.threadId.trim()
    ? options.threadId.trim()
    : null;
  try {
    const updated = await gmailPut<DraftResponse>(api, `users/${GMAIL_USER}/drafts/${encodeURIComponent(draftId)}`, {
      id: draftId,
      message: { raw: toBase64Url(raw), ...(threadId ? { threadId } : {}) },
    });
    return draftSaveFromResponse(updated, draftId);
  } catch (caught) {
    if (caught instanceof GoogleApiError && caught.code === 'RESOURCE_NOT_FOUND') return null;
    throw caught;
  }
}

/**
 * Create the saved draft, or update the one the composer already has.
 *
 * `existingDraftId` is the provider draft id resolved from the local row. A draft on
 * a *different* account can never be patched into this one, so the caller passes no
 * id in that case and this creates a fresh draft.
 */
export async function saveGmailUserDraft(
  api: GoogleApiOptions,
  composed: ComposedMail,
  options: { existingDraftId?: string | null; threadId?: string | null } = {},
): Promise<GmailDraftSave> {
  const existing = options.existingDraftId ?? null;
  if (existing) {
    const updated = await updateGmailDraft(api, existing, composed, { threadId: options.threadId });
    if (updated) return { ...updated, created: false };
    const created = await createGmailDraft(api, composed, { threadId: options.threadId });
    return { ...created, created: true, supersededId: existing };
  }
  return createGmailDraft(api, composed, { threadId: options.threadId });
}

/**
 * Remove a saved draft.
 *
 * A draft that is already gone is the **end state the caller asked for**, so a `404`
 * is not a failure: the local row is still removed and the operation is reported as
 * done. Any other provider refusal propagates, because the local row must not be
 * dropped while Gmail still holds the draft.
 */
export async function deleteGmailUserDraft(api: GoogleApiOptions, draftId: string): Promise<{ alreadyGone: boolean }> {
  try {
    await gmailDelete(api, `users/${GMAIL_USER}/drafts/${encodeURIComponent(draftId)}`);
    return { alreadyGone: false };
  } catch (caught) {
    if (caught instanceof GoogleApiError && caught.code === 'RESOURCE_NOT_FOUND') return { alreadyGone: true };
    throw caught;
  }
}

interface DraftListPage {
  drafts?: DraftResponse[] | null;
  nextPageToken?: string | null;
}

/** How many drafts one lookup will page through before giving up. */
export const GMAIL_DRAFT_LOOKUP_MAX_PAGES = 10;
const DRAFT_LOOKUP_PAGE_SIZE = 100;

/**
 * The provider draft id that wraps the message a local row holds.
 *
 * Gmail identifies a draft separately from its message, and the local model keeps only
 * the message identity (which is what the sync reconciles on). The draft id is
 * therefore read from the provider at the moment it is needed, bounded by
 * {@link GMAIL_DRAFT_LOOKUP_MAX_PAGES} pages: a draft beyond that bound is treated as
 * "not found", which creates a fresh draft rather than patching one this adapter
 * cannot address.
 */
export async function findGmailDraftIdForMessage(api: GoogleApiOptions, messageId: string): Promise<string | null> {
  let pageToken: string | null = null;
  for (let page = 0; page < GMAIL_DRAFT_LOOKUP_MAX_PAGES; page++) {
    const listed: DraftListPage = await gmailGet<DraftListPage>(
      api,
      `users/${GMAIL_USER}/drafts`,
      { maxResults: DRAFT_LOOKUP_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
    );
    for (const draft of listed.drafts ?? []) {
      if (draft?.message?.id === messageId && draft.id) return draft.id;
    }
    pageToken = listed.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return null;
}

export interface GmailDraftRecordInput {
  accountId: string;
  folder: string;
  /** The provider's **message** id: the local row is keyed on it, so a later sync updates it. */
  providerMessageId: string;
  threadId?: string | null;
  providerNamespace: string;
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

export interface GmailDraftRecord {
  /** The compatibility number the rest of the application addresses this draft by. */
  uid: string;
  rowId: string;
}

/**
 * Mirror a provider draft into the local `messages` table.
 *
 * The row is keyed by the **message** id — the same partial unique index the message
 * sync uses — and carries the same derived `uid`, the `gmail:` thread identity and the
 * `DRAFT` label, so a later history sync updates this row instead of inserting a
 * second one. The draft columns the composer reopens with (`draft_composition`,
 * `draft_bcc_addresses`, `draft_alias_id`, reply headers) are written here because
 * nothing else will: the sync projects message metadata, not composition state.
 */
export async function upsertGmailDraftRecord(input: GmailDraftRecordInput): Promise<GmailDraftRecord> {
  const uid = providerUidForGmailMessage(input.providerMessageId);
  const providerThreadId =
    typeof input.threadId === 'string'
      ? (input.threadId.trim() || null)
      : null;
  const result = await query<{ id: string; uid: string }>(
    `INSERT INTO messages (
       account_id, uid, folder, provider_message_id, message_id, subject,
       from_name, from_email, to_addresses, cc_addresses, in_reply_to, date, snippet,
       is_read, is_starred, has_attachments, flags, body_html, body_text,
       thread_id, provider_thread_id, provider_namespace, provider_labels,
       draft_bcc_addresses, draft_alias_id, draft_in_reply_to, draft_references, draft_composition,
       synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,
       true,false,false,$14::jsonb,$15,$16,
       $17,$18,$19,$20::text[],
       $21::jsonb,$22,$23,$24,$25::jsonb,
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
       provider_thread_id = EXCLUDED.provider_thread_id,
       provider_namespace = EXCLUDED.provider_namespace,
       provider_labels = EXCLUDED.provider_labels,
       draft_bcc_addresses = EXCLUDED.draft_bcc_addresses,
       draft_alias_id = EXCLUDED.draft_alias_id,
       draft_in_reply_to = EXCLUDED.draft_in_reply_to,
       draft_references = EXCLUDED.draft_references,
       draft_composition = EXCLUDED.draft_composition,
       synced_at = NOW()
     RETURNING id, uid::text AS uid`,
    [
      input.accountId, uid, input.folder, input.providerMessageId, input.messageId,
      input.subject || '(no subject)',
      input.fromName ?? '', input.fromEmail ?? '',
      JSON.stringify(input.to ?? []), JSON.stringify(input.cc ?? []),
      input.inReplyTo ?? null, input.date ?? new Date(), input.snippet ?? '',
      JSON.stringify(['\\Draft', '\\Seen']),
      input.bodyHtml ?? null, input.bodyText ?? null,
      providerThreadId ? `gmail:${providerThreadId}` : null,
      providerThreadId,
      input.providerNamespace,
      ['DRAFT'],
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

/** The provider **message** id a local row holds, if it is a draft this account owns. */
export async function gmailDraftMessageIdForLocalRow(accountId: string, uid: string | number, folder: string): Promise<string | null> {
  const result = await query<{ provider_message_id: string | null }>(
    'SELECT provider_message_id FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [accountId, String(uid), folder],
  );
  return result.rows[0]?.provider_message_id ?? null;
}
