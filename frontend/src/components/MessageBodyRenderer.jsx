import DOMPurify from 'dompurify';

export const EMAIL_SANITIZE_POLICY = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'track'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcset', 'style'],
};

function preserveCid(html) {
  return html.replace(/(src|href)=("|')cid:/gi, '$1=$2cid:');
}

export function sanitizeMessageHtml(html = '', { remoteImages = false } = {}) {
  const sanitized = DOMPurify.sanitize(preserveCid(String(html)), {
    ...EMAIL_SANITIZE_POLICY,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  if (remoteImages) return sanitized;
  return sanitized
    .replace(/\s(?:src|href)=("|')https?:[^"']*\1/gi, '')
    .replace(/\ssrcset=("|')[^"']*\1/gi, '')
    .replace(/url\s*\(\s*["']?https?:[^)]+\)/gi, 'none');
}

export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false }) {
  if (!html) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
  return <div dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(html, { remoteImages }) }} />;
}
