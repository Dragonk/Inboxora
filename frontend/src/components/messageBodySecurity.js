import DOMPurifyModule from 'dompurify';

function purifier() {
  if (typeof DOMPurifyModule?.sanitize === 'function') return DOMPurifyModule;
  if (typeof DOMPurifyModule === 'function' && typeof window !== 'undefined') return DOMPurifyModule(window);
  throw new Error('DOMPurify requires a browser document');
}

// Shared email HTML security policy. This is a leaf module so browser tests and
// both React renderers exercise the exact same sanitizer/CSP/srcDoc implementation.
export const EMAIL_SANITIZE_POLICY = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'track', 'style'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
};

function preserveCid(html) {
  return html.replace(/(src|href)=("|')cid:/gi, '$1=$2cid:');
}

export function sanitizeMessageHtml(html = '', { remoteImages = false } = {}) {
  const purify = purifier();
  const sanitized = purify.sanitize(preserveCid(String(html)), {
    ...EMAIL_SANITIZE_POLICY,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  if (remoteImages) return sanitized;
  return sanitized
    .replace(/\ssrc=(["'])https?:[^"']*\1/gi, '')
    .replace(/\ssrc=(["'])\/\/[^"']*\1/gi, '')
    .replace(/\ssrcset=(["'])[^"']*\1/gi, '')
    .replace(/url\s*\(\s*["']?https?:[^)]+\)/gi, 'none')
    .replace(/url\s*\(\s*["']?\/\/[^)]+\)/gi, 'none');
}

export function emailCsp({ remoteImages = false } = {}) {
  return remoteImages
    ? "default-src 'none'; img-src 'self' data: cid: https:; style-src 'unsafe-inline'; media-src 'self' data:"
    : "default-src 'none'; img-src 'self' data: cid:; style-src 'unsafe-inline'; media-src 'self' data:";
}

export const EMAIL_BASE_TAG = '<base target="_blank" rel="noopener noreferrer">';

export function buildSrcDoc(html, { remoteImages = false } = {}) {
  const csp = emailCsp({ remoteImages });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${EMAIL_BASE_TAG}
<style>
  html { overflow: hidden; }
  body { overflow: hidden; margin: 0; padding: 8px; word-wrap: break-word; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: inherit; }
  blockquote { margin-left: 1em; border-left: 3px solid var(--border, #ddd); padding-left: 1em; color: inherit; opacity: 0.8; }
</style>
</head><body>${html}</body></html>`;
}
