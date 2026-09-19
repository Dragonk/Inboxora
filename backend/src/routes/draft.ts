import nodemailer from 'nodemailer';
import type { EmailAccountRow } from '../services/imapManager.js';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { resolveSenderIdentity } from '../services/senderIdentity.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { imapManager } from '../index.js';
import { Readable } from 'node:stream';
import { queryString } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import { parseMailbox, type ComposedMail } from '../services/composedMail.js';
import { resolveMailTransportForSync } from '../services/mailTransportTarget.js';
import {
  deleteGraphUserDraft,
  graphDraftIdForLocalRow,
  saveGraphUserDraft,
  upsertGraphDraftRecord,
} from '../services/providers/microsoft/graphMailDrafts.js';
import { gmailProviderNamespace } from '../services/providers/google/gmailMail.js';
import {
  deleteGmailUserDraft,
  findGmailDraftIdForMessage,
  gmailDraftMessageIdForLocalRow,
  saveGmailUserDraft,
  upsertGmailDraftRecord,
} from '../services/providers/google/gmailMailDrafts.js';

const router = Router();
router.use(requireAuth);

// An address field as it arrives from the compose request body: a single
// address or a list of addresses (both optional).
type RecipientInput = string | string[] | null | undefined;

type RawDraftInput = {
  accountId: string;
  aliasId?: string | null;
  to?: RecipientInput;
  cc?: RecipientInput;
  bcc?: RecipientInput;
  subject?: string | null;
  body?: string | null;
  bodyIsHtml?: boolean;
  quotedBody?: string | null;
  quotedBodyHtml?: string | null;
  editedSignature?: string | null;
  editedSignatureIsHtml?: boolean;
  hasEditedSignature?: boolean;
  inReplyTo?: string | null;
  references?: string | null;
};

type ExistingDraftIdentity = {
  accountId: string;
  uid: number;
  folder: string;
  /**
   * The IMAP UIDVALIDITY that guards the identity. It is **absent for a provider account**, whose
   * draft is identified by the immutable provider id recorded on its local row — there is no UID
   * generation to confirm, and inventing one would be a guard that guards nothing.
   */
  uidValidity: number | null;
};

/**
 * A positive integer as JSON actually delivers it.
 *
 * `messages.uid` is BIGINT, and the driver returns it as a **string** to keep the value exact, so the
 * interface sends back what it was given. Requiring a JSON number here would reject every real draft
 * identity and quietly turn each autosave into a brand-new draft, so both forms are accepted and
 * normalised.
 */
function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function existingDraftIdentity(value: unknown): ExistingDraftIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accountId !== 'string' || !candidate.accountId) return null;
  const uid = positiveInteger(candidate.uid);
  if (uid === null) return null;
  if (typeof candidate.folder !== 'string' || !candidate.folder || candidate.folder.length > 1024 || /[\0\r\n]/.test(candidate.folder)) return null;
  if (candidate.uidValidity === undefined || candidate.uidValidity === null) {
    return { accountId: candidate.accountId, uid, folder: candidate.folder, uidValidity: null };
  }
  const uidValidity = positiveInteger(candidate.uidValidity);
  if (uidValidity === null) return null;
  return { accountId: candidate.accountId, uid, folder: candidate.folder, uidValidity };
}

function sanitizeHeaderValue(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

// Extract { name, email } from an RFC 5322 address string ("Name <email>",
// "<email>", or bare "email") for persisting to_addresses/cc_addresses.
function parseAddress(str: string) {
  if (typeof str !== 'string') return { name: '', email: '' };
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}
function mapRecipientList(list: RecipientInput) {
  return (Array.isArray(list) ? list : []).filter(Boolean).map(addr => parseAddress(addr));
}

function textToHtml(text: string) {
  return text.split('\n')
    .map(l => `<p style="margin:0">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</p>`)
    .join('');
}

async function buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature, editedSignatureIsHtml = true, hasEditedSignature = false, inReplyTo, references }: RawDraftInput) {
  const acctResult = await query<EmailAccountRow & { email_address: string }>(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!acctResult.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const account = acctResult.rows[0];

  const { fromName, fromEmail, fromReplyTo, fromSignature, aliasId: resolvedAliasId } = await resolveSenderIdentity(account, aliasId);

  const rawSignature = hasEditedSignature ? (editedSignature || null) : fromSignature;
  const signatureIsHtml = hasEditedSignature ? editedSignatureIsHtml : true;
  const effectiveSignature = rawSignature ? (signatureIsHtml ? sanitizeSignature(rawSignature) : textToHtml(rawSignature)) : null;

  const sigText = rawSignature
    ? (signatureIsHtml ? sanitizeHtml(effectiveSignature || '', { allowedTags: [], allowedAttributes: {} }).trim() : rawSignature)
    : null;

  const bodyText = bodyIsHtml
    ? sanitizeHtml(body || '', { allowedTags: [], allowedAttributes: {} })
    : (body || '');

  const bodyHtml = bodyIsHtml
    ? sanitizeComposeBody(body || '')
    : textToHtml(body || '');

  const rawHtml = bodyHtml +
    (effectiveSignature ? `<div style="margin-top:16px;color:#555;font-size:13px">${effectiveSignature}</div>` : '') +
    (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
  const { html: draftHtml, attachments: inlineImageAttachments } = embedInlineDataImages(rawHtml);

  // Stable Message-ID so the appended MIME and the local DB row reference the same
  // message (and a later sync reconciles cleanly).
  const messageId = `<${randomBytes(16).toString('hex')}@${(fromEmail.split('@')[1] || 'mailflow.local')}>`;
  const textBody = sigText ? `${bodyText}\n\n-- \n${sigText}${quotedBody || ''}` : `${bodyText}${quotedBody || ''}`;

  const mailOptions = {
    messageId,
    from: `${fromName} <${fromEmail}>`,
    ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
    to: (Array.isArray(to) ? to : [to]).filter(Boolean).join(', ') || undefined,
    cc: (Array.isArray(cc) ? cc : []).filter(Boolean).join(', ') || undefined,
    bcc: (Array.isArray(bcc) ? bcc : []).filter(Boolean).join(', ') || undefined,
    subject: sanitizeHeaderValue(subject || ''),
    ...(inReplyTo ? { inReplyTo: sanitizeHeaderValue(inReplyTo) } : {}),
    ...(references ? { references: sanitizeHeaderValue(references) } : {}),
    text: textBody,
    html: draftHtml,
    ...(inlineImageAttachments.length ? { attachments: inlineImageAttachments } : {}),
  };

  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks: Buffer[] = [];
  await new Promise((resolve, reject) => {
    const messageStream = streamInfo.message;
    if (!(messageStream instanceof Readable)) {
      reject(new Error('Stream transport did not return a readable message'));
      return;
    }
    messageStream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    messageStream.on('end', resolve);
    messageStream.on('error', reject);
  });
  // rawHtml (pre inline-image embedding) is what the composer should reopen with —
  // inline data: URIs stay editable and getMessageBody serves body_html from the DB.
  const snippet = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);

  // The canonical model, so a provider transport renders the draft itself instead of the route
  // reaching for a message format. SMTP's MIME below is one rendering of it; Graph's JSON — which
  // keeps `bccRecipients` out of band — is another, and it is built from these same fields.
  const recipientMailboxes = (value: RecipientInput) =>
    (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean).map(entry => parseMailbox(String(entry)));
  const composed: ComposedMail = {
    messageId,
    from: { email: fromEmail, name: fromName ?? undefined },
    replyTo: fromReplyTo ? parseMailbox(fromReplyTo) : null,
    to: recipientMailboxes(to),
    cc: recipientMailboxes(cc),
    bcc: recipientMailboxes(bcc),
    subject: sanitizeHeaderValue(subject || ''),
    plainBody: textBody,
    htmlBody: draftHtml,
    inReplyTo: inReplyTo ? sanitizeHeaderValue(inReplyTo) : null,
    references: references ? sanitizeHeaderValue(references) : null,
    ...(inlineImageAttachments.length ? {
      attachments: inlineImageAttachments.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        cid: attachment.cid,
        contentDisposition: attachment.contentDisposition,
      })),
    } : {}),
  };

  return {
    rawMessage: Buffer.concat(chunks),
    account,
    composed,
    meta: {
      messageId, fromName, fromEmail, bodyHtml: rawHtml, bodyText: textBody, snippet,
      aliasId: resolvedAliasId,
      inReplyTo: inReplyTo ? sanitizeHeaderValue(inReplyTo) : null,
      references: references ? sanitizeHeaderValue(references) : null,
      draftComposition: { version: 2, authoredBody: body || '', bodyIsHtml: Boolean(bodyIsHtml), signatureHtml: effectiveSignature, signatureText: sigText, quotedBody: quotedBody || null, quotedBodyHtml: quotedBodyHtml || null },
    },
  };
}

async function resolveDraftsFolder(account: EmailAccountRow) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await query<{ path: string }>(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id]
  );
  return result.rows[0]?.path || null;
}

/**
 * Remove the provider draft a previous save created on **another** account.
 *
 * The draft's identity is scoped to its own account, so the removal runs with that account's
 * credentials: using the destination account would address an unrelated provider object. A previous
 * account that is gone, or no longer native, leaves the draft in place — the caller's local row is
 * retained and the situation is logged rather than guessed at.
 */
async function deleteProviderDraftByIdentity(userId: string, identity: ExistingDraftIdentity): Promise<boolean> {
  const previousRows = await query<EmailAccountRow>(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [identity.accountId, userId],
  );
  const previous = previousRows.rows[0];
  if (!previous) return false;
  if (previous.mail_transport !== 'microsoft_graph' && previous.mail_transport !== 'gmail_api') return false;
  const target = await resolveMailTransportForSync(userId, previous.id);
  if (target.kind === 'graph') {
    const providerId = await graphDraftIdForLocalRow(previous.id, identity.uid, identity.folder);
    if (!providerId) return false;
    await deleteGraphUserDraft(
      { userId, connectionId: target.connectionId, config: target.config },
      providerId,
    );
  } else if (target.kind === 'gmail') {
    // A Gmail draft is addressed by its draft id, which the local row does not carry:
    // it is resolved from the message identity the row does hold.
    const messageId = await gmailDraftMessageIdForLocalRow(previous.id, identity.uid, identity.folder);
    if (!messageId) return false;
    const api = { userId, connectionId: target.connectionId, config: target.config };
    const draftId = await findGmailDraftIdForMessage(api, messageId);
    if (!draftId) return false;
    await deleteGmailUserDraft(api, draftId);
  } else {
    return false;
  }
  await query(
    'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [previous.id, identity.uid, identity.folder],
  );
  return true;
}

router.post('/draft', async (req, res) => {
  const { accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, editedSignature, editedSignatureIsHtml, inReplyTo, references } = req.body;
  if (editedSignatureIsHtml !== undefined && typeof editedSignatureIsHtml !== 'boolean') return res.status(400).json({ error: 'editedSignatureIsHtml must be a boolean' });
  const hasEditedSignature = Object.prototype.hasOwnProperty.call(req.body || {}, 'editedSignature');
  const existingDraft = existingDraftIdentity(req.body?.existingDraft);
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const ownerCheck = await query<{ id: string }>(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const { rawMessage, account, composed, meta } = await buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature, editedSignatureIsHtml, hasEditedSignature, inReplyTo, references });

    const draftsFolder = await resolveDraftsFolder(account);
    if (!draftsFolder) return res.status(422).json({ error: 'No Drafts folder found for this account' });

    // A native account saves the draft as the provider's own object. The branch is decided from the row
    // already loaded, and only a native account pays for resolving (and enforcing) the provider target:
    // the layer switch, the configuration and the connection are the same three answers every
    // provider-backed mail path uses.
    if (account.mail_transport === 'microsoft_graph') {
      const target = await resolveMailTransportForSync(req.session.userId!, account.id);
      if (target.kind === 'refused') return res.status(target.status).json({ error: target.error });
      if (target.kind !== 'graph') return res.status(409).json({ error: 'This account is not linked to a Microsoft connection' });
      const api = { userId: req.session.userId!, connectionId: target.connectionId, config: target.config };

      // Only a draft this account owns can be patched in place: its provider id is read from the local
      // row. A draft held on another account is a different provider object and is removed separately.
      const sameAccountDraft = existingDraft && existingDraft.accountId === account.id ? existingDraft : null;
      const existingProviderId = sameAccountDraft
        ? await graphDraftIdForLocalRow(account.id, sameAccountDraft.uid, sameAccountDraft.folder)
        : null;
      const saved = await saveGraphUserDraft(api, composed, { existingDraftId: existingProviderId });

      const record = await upsertGraphDraftRecord({
        accountId: account.id,
        folder: draftsFolder,
        providerDraftId: saved.id,
        messageId: meta.messageId,
        subject,
        fromName: meta.fromName,
        fromEmail: meta.fromEmail,
        to: mapRecipientList(to),
        cc: mapRecipientList(cc),
        bcc: mapRecipientList(bcc),
        aliasId: meta.aliasId,
        inReplyTo: meta.inReplyTo,
        references: meta.references,
        snippet: meta.snippet,
        bodyHtml: meta.bodyHtml,
        bodyText: meta.bodyText,
        draftComposition: meta.draftComposition,
      });

      // The provider object the composer held was replaced rather than updated (it was gone at the
      // provider), so remove the superseded one. A failure here is logged, not fatal: the save itself
      // succeeded, and the next sync surfaces the stale draft if it survives.
      if (saved.supersededId) {
        await deleteGraphUserDraft(api, saved.supersededId)
          .catch(caught => console.error(`Draft: failed to remove superseded provider draft: ${toAppError(caught).message}`));
      }
      if (existingDraft && existingDraft.accountId !== account.id) {
        await deleteProviderDraftByIdentity(req.session.userId!, existingDraft)
          .catch(caught => console.error(`Draft: failed to remove the previous account's provider draft: ${toAppError(caught).message}`));
      }

      // No UIDVALIDITY: a provider draft's identity is its immutable provider id, which the local row
      // holds. `uid` is the compatibility number the rest of the application addresses rows by.
      return res.json({ uid: record.uid, folder: draftsFolder, uidValidity: null, rowId: record.rowId });
    }

    // A Gmail API account saves the draft as Gmail's own `Draft` object. The local row is keyed on the
    // **message** id the draft wraps — the identity the message sync reconciles on — while the draft id
    // a patch or delete addresses is resolved from the provider at that moment, because the local model
    // has no column for a second identity.
    if (account.mail_transport === 'gmail_api') {
      const target = await resolveMailTransportForSync(req.session.userId!, account.id);
      if (target.kind === 'refused') return res.status(target.status).json({ error: target.error });
      if (target.kind !== 'gmail') return res.status(409).json({ error: 'This account is not linked to a Google connection' });
      const api = { userId: req.session.userId!, connectionId: target.connectionId, config: target.config };

      const sameAccountDraft = existingDraft && existingDraft.accountId === account.id ? existingDraft : null;
      const existingMessageId = sameAccountDraft
        ? await gmailDraftMessageIdForLocalRow(account.id, sameAccountDraft.uid, sameAccountDraft.folder)
        : null;
      const existingDraftId = existingMessageId ? await findGmailDraftIdForMessage(api, existingMessageId) : null;
      const saved = await saveGmailUserDraft(api, composed, { existingDraftId });

      const record = await upsertGmailDraftRecord({
        accountId: account.id,
        folder: draftsFolder,
        providerMessageId: saved.messageId,
        threadId: saved.threadId,
        providerNamespace: gmailProviderNamespace(account.id),
        messageId: meta.messageId,
        subject,
        fromName: meta.fromName,
        fromEmail: meta.fromEmail,
        to: mapRecipientList(to),
        cc: mapRecipientList(cc),
        bcc: mapRecipientList(bcc),
        aliasId: meta.aliasId,
        inReplyTo: meta.inReplyTo,
        references: meta.references,
        snippet: meta.snippet,
        bodyHtml: meta.bodyHtml,
        bodyText: meta.bodyText,
        draftComposition: meta.draftComposition,
      });

      // The provider object the composer held was replaced rather than updated (it was gone at Gmail),
      // so remove the superseded one. A failure is logged, not fatal: the save itself succeeded.
      if (saved.supersededId) {
        await deleteGmailUserDraft(api, saved.supersededId)
          .catch(caught => console.error(`Draft: failed to remove superseded Gmail draft: ${toAppError(caught).message}`));
      }
      if (existingDraft && existingDraft.accountId !== account.id) {
        await deleteProviderDraftByIdentity(req.session.userId!, existingDraft)
          .catch(caught => console.error(`Draft: failed to remove the previous account's provider draft: ${toAppError(caught).message}`));
      }

      return res.json({ uid: record.uid, folder: draftsFolder, uidValidity: null, rowId: record.rowId });
    }

    // APPEND the new draft first so we never lose the message
    const { uid, uidValidity } = await imapManager.appendToFolder(account, draftsFolder, rawMessage, ['\\Draft', '\\Seen']);

    // Persist a local Drafts row immediately so the composer can reopen this draft
    // (recipient/subject/body) even if the folder re-sync is delayed or fails on a
    // flaky connection. Non-fatal — the append already stored the message on IMAP.
    if (uid != null) {
      try {
        await imapManager.upsertDraftMessageRecord(account, draftsFolder, uid, {
          messageId: meta.messageId,
          subject,
          fromName: meta.fromName,
          fromEmail: meta.fromEmail,
          to: mapRecipientList(to),
          cc: mapRecipientList(cc),
          bcc: mapRecipientList(bcc),
          aliasId: meta.aliasId,
          inReplyTo: meta.inReplyTo,
          references: meta.references,
          draftComposition: meta.draftComposition,
          snippet: meta.snippet,
          bodyHtml: meta.bodyHtml,
          bodyText: meta.bodyText,
          uidValidity,
        });
      } catch (caught) {
        const rowErr = toAppError(caught);
        console.error(`Draft: failed to persist local row uid=${uid}: ${rowErr.message}`);
      }
    }

    // Delete a prior draft only after APPEND returned its new UID. Its identity is
    // independent from the selected sender: IMAP UIDs are scoped to an account and
    // folder, so using the destination account here could delete an unrelated draft.
    // An IMAP draft without a confirmed UIDVALIDITY cannot be addressed safely, so it
    // is retained with a warning rather than deleted on a guess.
    if (uid != null && existingDraft && existingDraft.uidValidity !== null) {
      try {
        const previousAccount = await query<EmailAccountRow>(
          'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
          [existingDraft.accountId, req.session.userId],
        );
        const previous = previousAccount.rows[0];
        if (!previous) {
          console.warn(`Draft: previous draft account is unavailable; retaining uid=${existingDraft.uid}`);
        } else {
          const previousDraftsFolder = await resolveDraftsFolder(previous);
          const storedIdentity = await query<{ draft_uid_validity: number | string | null }>(
            'SELECT draft_uid_validity FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
            [previous.id, existingDraft.uid, existingDraft.folder],
          );
          const storedUidValidity = Number(storedIdentity.rows[0]?.draft_uid_validity);
          if (previousDraftsFolder !== existingDraft.folder || storedUidValidity !== existingDraft.uidValidity) {
            console.warn(`Draft: previous draft identity cannot be confirmed; retaining uid=${existingDraft.uid}`);
          } else {
            await imapManager.permanentDeleteMessage(previous, existingDraft.uid, existingDraft.folder, existingDraft.uidValidity);
            await query(
              'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND draft_uid_validity = $4',
              [previous.id, existingDraft.uid, existingDraft.folder, existingDraft.uidValidity],
            );
          }
        }
      } catch (caught) {
        const delErr = toAppError(caught);
        console.error(`Draft: failed to delete old uid=${existingDraft.uid}: ${delErr.message}`);
      }
    }

    res.json({ uid, folder: draftsFolder, uidValidity });
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Save draft failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to save draft' });
  }
});

router.delete('/draft/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (!uid || !Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid uid' });

  const accountId = queryString(req.query.accountId);
  const folder = queryString(req.query.folder);
  const rawUidValidity = queryString(req.query.uidValidity);
  const uidValidity = rawUidValidity === undefined || rawUidValidity === '' ? null : Number(rawUidValidity);
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });
  if (uidValidity !== null && (!Number.isSafeInteger(uidValidity) || uidValidity <= 0)) {
    return res.status(400).json({ error: 'uidValidity must be a positive integer' });
  }

  const ownerCheck = await query<EmailAccountRow>(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const account = ownerCheck.rows[0];
    if (await resolveDraftsFolder(account) !== folder) return res.status(409).json({ error: 'Draft folder cannot be confirmed' });

    // A native account's draft is removed at the provider, addressed by the immutable id on the local
    // row — there is no UIDVALIDITY to confirm, and the row is only dropped after the provider confirms.
    if (account.mail_transport === 'microsoft_graph') {
      const target = await resolveMailTransportForSync(req.session.userId!, account.id);
      if (target.kind === 'refused') return res.status(target.status).json({ error: target.error });
      if (target.kind !== 'graph') return res.status(409).json({ error: 'This account is not linked to a Microsoft connection' });
      const providerId = await graphDraftIdForLocalRow(account.id, uid, folder);
      if (!providerId) return res.status(409).json({ error: 'Draft identity cannot be confirmed' });
      await deleteGraphUserDraft(
        { userId: req.session.userId!, connectionId: target.connectionId, config: target.config },
        providerId,
      );
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND provider_message_id = $4',
        [account.id, uid, folder, providerId],
      );
      return res.json({ ok: true });
    }

    if (account.mail_transport === 'gmail_api') {
      const target = await resolveMailTransportForSync(req.session.userId!, account.id);
      if (target.kind === 'refused') return res.status(target.status).json({ error: target.error });
      if (target.kind !== 'gmail') return res.status(409).json({ error: 'This account is not linked to a Google connection' });
      const api = { userId: req.session.userId!, connectionId: target.connectionId, config: target.config };
      const messageId = await gmailDraftMessageIdForLocalRow(account.id, uid, folder);
      if (!messageId) return res.status(409).json({ error: 'Draft identity cannot be confirmed' });
      const draftId = await findGmailDraftIdForMessage(api, messageId);
      // A draft the provider no longer holds is the end state the caller asked for, so
      // the local row still goes; only a provider refusal stops the removal.
      if (draftId) await deleteGmailUserDraft(api, draftId);
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND provider_message_id = $4',
        [account.id, uid, folder, messageId],
      );
      return res.json({ ok: true });
    }

    if (uidValidity === null) return res.status(400).json({ error: 'uidValidity required' });
    const storedIdentity = await query<{ draft_uid_validity: number | string | null }>(
      'SELECT draft_uid_validity FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
      [account.id, uid, folder],
    );
    if (Number(storedIdentity.rows[0]?.draft_uid_validity) !== uidValidity) {
      return res.status(409).json({ error: 'Draft identity cannot be confirmed' });
    }
    await imapManager.permanentDeleteMessage(account, uid, folder, uidValidity);
    await query(
      'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND draft_uid_validity = $4',
      [account.id, uid, folder, uidValidity]
    );
    res.json({ ok: true });
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Delete draft failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

export default router;
