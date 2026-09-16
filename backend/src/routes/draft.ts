import nodemailer from 'nodemailer';
import type { EmailAccountRow } from '../services/imapManager.js';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { imapManager } from '../index.js';
import { Readable } from 'node:stream';
import { queryString } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';

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
};

type ExistingDraftIdentity = {
  accountId: string;
  uid: number;
  folder: string;
  uidValidity: number;
};

function existingDraftIdentity(value: unknown): ExistingDraftIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accountId !== 'string' || !candidate.accountId) return null;
  if (typeof candidate.uid !== 'number' || !Number.isSafeInteger(candidate.uid) || candidate.uid <= 0) return null;
  if (typeof candidate.folder !== 'string' || !candidate.folder || candidate.folder.length > 1024 || /[\0\r\n]/.test(candidate.folder)) return null;
  if (typeof candidate.uidValidity !== 'number' || !Number.isSafeInteger(candidate.uidValidity) || candidate.uidValidity <= 0) return null;
  return { accountId: candidate.accountId, uid: candidate.uid, folder: candidate.folder, uidValidity: candidate.uidValidity };
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

async function buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature }: RawDraftInput) {
  const acctResult = await query<EmailAccountRow & { email_address: string }>(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!acctResult.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const account = acctResult.rows[0];

  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;

  if (aliasId) {
    const aliasResult = await query<{ name: string; email: string; signature: string | null }>(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      fromName = alias.name;
      fromEmail = alias.email;
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  const rawSignature = editedSignature !== undefined ? (editedSignature || null) : fromSignature;
  const effectiveSignature = rawSignature ? sanitizeSignature(rawSignature) : null;

  const sigText = effectiveSignature
    ? sanitizeHtml(effectiveSignature, { allowedTags: [], allowedAttributes: {} }).trim()
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
    to: (Array.isArray(to) ? to : [to]).filter(Boolean).join(', ') || undefined,
    cc: (Array.isArray(cc) ? cc : []).filter(Boolean).join(', ') || undefined,
    bcc: (Array.isArray(bcc) ? bcc : []).filter(Boolean).join(', ') || undefined,
    subject: sanitizeHeaderValue(subject || ''),
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
  return {
    rawMessage: Buffer.concat(chunks),
    account,
    meta: { messageId, fromName, fromEmail, bodyHtml: rawHtml, bodyText: textBody, snippet },
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

router.post('/draft', async (req, res) => {
  const { accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, editedSignature } = req.body;
  const existingDraft = existingDraftIdentity(req.body?.existingDraft);
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const ownerCheck = await query<{ id: string }>(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const { rawMessage, account, meta } = await buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature });

    const draftsFolder = await resolveDraftsFolder(account);
    if (!draftsFolder) return res.status(422).json({ error: 'No Drafts folder found for this account' });

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
    if (uid != null && existingDraft) {
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
  const uidValidity = Number(queryString(req.query.uidValidity));
  if (!accountId || !folder || !Number.isSafeInteger(uidValidity) || uidValidity <= 0) return res.status(400).json({ error: 'accountId, folder and uidValidity required' });

  const ownerCheck = await query<EmailAccountRow>(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const account = ownerCheck.rows[0];
    if (await resolveDraftsFolder(account) !== folder) return res.status(409).json({ error: 'Draft folder cannot be confirmed' });
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
