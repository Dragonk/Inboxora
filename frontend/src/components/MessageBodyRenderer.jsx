import DOMPurify from 'dompurify';

export const EMAIL_SANITIZE_POLICY = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'track'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcset', 'style'],
};

// Preserve cid: references so they survive DOMPurify (which would strip them
// as unknown-protocol attributes). The renderer maps them to a safe API URL
// after sanitization.
function preserveCid(html) {
  return html.replace(/(src|href)=("|')cid:/gi, '$1=$2cid:');
}

// Replace cid: references with a safe local API endpoint. The backend resolves
// the CID to the matching attachment content served from the message's physical
// copy. This prevents cid: from remaining a dead browser URL.
function mapCidToApi(html, { copyId, accountId } = {}) {
  if (!copyId) return html;
  return html.replace(/(src|href)=("|')cid:([^"']+)\2/gi, (match, attr, quote, cid) => {
    const api = `/api/mail/attachments/cid?cid=${encodeURIComponent(cid)}&copyId=${encodeURIComponent(copyId)}&accountId=${encodeURIComponent(accountId || '')}`;
    return `${attr}=${quote}${api}${quote}`;
  });
}

export function sanitizeMessageHtml(html = '', { remoteImages = false } = {}) {
  const sanitized = DOMPurify.sanitize(preserveCid(String(html)), {
    ...EMAIL_SANITIZE_POLICY,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  if (remoteImages) return sanitized;
  // Block all remote resources:
  // - http:// and https:// in src, href (except <a href> which stays clickable)
  // - protocol-relative URLs (//host/path)
  // - srcset (already in FORBID_ATTR but double-ensure via regex)
  // - CSS url() with external references
  return sanitized
    .replace(/\ssrc=(["'])https?:[^"']*\1/gi, '')
    .replace(/\ssrc=(["'])\/\/[^"']*\1/gi, '')
    .replace(/\ssrcset=(["'])[^"']*\1/gi, '')
    .replace(/url\s*\(\s*["']?https?:[^)]+\)/gi, 'none')
    .replace(/url\s*\(\s*["']?\/\/[^)]+\)/gi, 'none');
}

export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false, copyId = null, accountId = null }) {
  if (!html) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
  const sanitized = sanitizeMessageHtml(html, { remoteImages });
  const finalHtml = mapCidToApi(sanitized, { copyId, accountId });
  return <div dangerouslySetInnerHTML={{ __html: finalHtml }} />;
}
