import { collectOwnAddresses, parseAddressListField, pickReplyAlias } from './replyAlias.js';

function messageIds(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  const ids = [];
  for (const match of text.matchAll(/<[^<>\r\n]+>/g)) {
    const id = match[0].trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * P1-15: Single source of truth for the In-Reply-To / References headers of a
 * reply to `message`.
 *
 * Both single-message and conversation-reader reply paths MUST
 * build these headers through this helper so the two reply paths produce byte-
 * identical output:
 *   - In-Reply-To = the parent Message-ID,
 *   - References  = existing References + existing In-Reply-To + parent
 *                   Message-ID, in that order, angle-bracketed, normalized and
 *                   de-duplicated (preserving first-seen order).
 *
 * Returns `{ inReplyTo, references }` where `references` is a space-joined
 * string or `null` when no Message-ID is available at all.
 */
export function buildReplyHeaders(message) {
  const inReplyTo = message?.message_id || null;
  const chain = [
    ...messageIds(message?.references || message?.thread_references),
    ...messageIds(message?.in_reply_to),
    ...messageIds(inReplyTo),
  ];
  // Dedup preserving first-seen order (messageIds already dedups within each
  // field, but the same id can appear in both References and In-Reply-To).
  const seen = new Set();
  const ordered = [];
  for (const id of chain) {
    if (!seen.has(id)) { seen.add(id); ordered.push(id); }
  }
  const references = ordered.join(' ') || null;
  return { inReplyTo, references };
}

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

export async function openReplyFromMessage(message, { accounts, openCompose, getMessageBody, replyAll = false }) {
  const replyToArr = Array.isArray(message.reply_to)
    ? message.reply_to
    : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
  const replyTarget = (replyToArr.length && replyToArr[0].email)
    ? replyToArr[0]
    : { name: message.from_name || '', email: message.from_email || '' };
  const sender = replyTarget.email ? [replyTarget] : [];

  const myAccount = accounts.find(a => a.id === message.account_id);
  // P1-16: use the central own-identity resolver so Reply All self-exclusion
  // covers primary + aliases + delivery_addresses (Delivered-To / X-Original-To /
  // Envelope-To), matching backend `resolveOwnIdentityAddresses`. This prevents
  // Cc'ing the user's own catch-all / shared alias copy back to themselves.
  const myAddresses = collectOwnAddresses({ account: myAccount, message });

  const replyAliasId = pickReplyAlias({
    aliases: myAccount?.aliases || [],
    deliveryAddresses: message.delivery_addresses,
    toAddresses: message.to_addresses,
    ccAddresses: message.cc_addresses,
    fromEmail: message.from_email,
  });

  const allRecipients = (() => {
    try {
      const toArr = parseAddressListField(message.to_addresses);
      const ccArr = parseAddressListField(message.cc_addresses);
      const seen = new Set();
      return [...toArr, ...ccArr].filter(t => {
        const email = t.email?.toLowerCase();
        if (!email || myAddresses.has(email) || email === (replyTarget.email || '').toLowerCase() || seen.has(email)) return false;
        seen.add(email);
        return true;
      });
    } catch { return []; }
  })();

  // P1-15: build In-Reply-To / References via the single shared helper so this
  // path and MessagePane.jsx produce byte-identical reply headers.
  const { inReplyTo, references: referencesChain } = buildReplyHeaders(message);
  const rawSubject = (message.subject || '').trim();

  const replyBody = await getMessageBody(message.id, false, message.selectedCopyId || message.id).catch(() => null);
  const replyDate = message.date ? new Date(message.date).toLocaleString() : '';
  const replySafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const replyFromStr = replySafeName
    ? `${replySafeName} <${message.from_email}>`
    : message.from_email || '';
  const quotedText = replyBody?.text
    ? `\n\n---\nOn ${replyDate}, ${replyFromStr} wrote:\n${replyBody.text.split('\n').map(l => '> ' + l).join('\n')}`
    : '';
  const quotedBodyHtml = replyBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${replyDate}, ${replyFromStr} wrote:</p>${replyBody.html}</div>`
    : null;

  openCompose({
    to: sender,
    cc: replyAll ? allRecipients : [],
    subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
    body: '',
    quotedBody: quotedText,
    quotedBodyHtml,
    inReplyTo,
    references: referencesChain,
    accountId: message.account_id,
    aliasId: replyAliasId,
    isReply: true,
    isReplyAll: replyAll,
    originalFrom: sender,
    allRecipients,
  });
}

export async function openForwardFromMessage(message, { openCompose, getMessageBody }) {
  const fwdBody = await getMessageBody(message.id, false, message.selectedCopyId || message.id).catch(() => null);
  const fwdDate = message.date ? new Date(message.date).toLocaleString() : '';
  const fwdSafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const fwdFromStr = fwdSafeName
    ? `${fwdSafeName} <${message.from_email}>`
    : message.from_email || '';
  const safeSubject = (message.subject || '').replace(/[\r\n]+/g, ' ');
  const toStr = parseAddressField(message.to_addresses);
  const ccStr = parseAddressField(message.cc_addresses);

  const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fwdFromStr}\nDate: ${fwdDate}\nSubject: ${safeSubject}${toStr ? `\nTo: ${toStr}` : ''}${ccStr ? `\nCc: ${ccStr}` : ''}\n\n${fwdBody?.text || ''}`;
  const fwdHtml = fwdBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${fwdFromStr}<br>Date: ${fwdDate}<br>Subject: ${safeSubject}${toStr ? `<br>To: ${toStr}` : ''}${ccStr ? `<br>Cc: ${ccStr}` : ''}</p>${fwdBody.html}</div>`
    : null;

  openCompose({
    subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    body: '',
    quotedBody: fwdText,
    quotedBodyHtml: fwdHtml,
    accountId: message.account_id,
    isForward: true,
    forwardedAttachments: (fwdBody?.attachments || []).map(att => ({
      messageId: message.id,
      part: att.part,
      filename: att.filename || 'attachment',
      type: att.type || 'application/octet-stream',
      size: att.size || 0,
    })),
  });
}
