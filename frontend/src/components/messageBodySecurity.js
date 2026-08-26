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
    ADD_ATTR: [...EMAIL_SANITIZE_POLICY.ADD_ATTR, 'data-mailflow-remote-src', 'data-mailflow-remote-blocked'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  for (const image of template.content.querySelectorAll('img')) {
    const currentSrc = image.getAttribute('src') || '';
    const preservedSrc = image.getAttribute('data-mailflow-remote-src') || '';
    const remoteSrc = /^(?:https?:)?\/\//i.test(currentSrc) ? currentSrc : preservedSrc;
    if (!remoteSrc) continue;
    const normalizedSrc = remoteSrc.startsWith('//') ? `https:${remoteSrc}` : remoteSrc;
    if (remoteImages) {
      image.setAttribute('src', normalizedSrc);
      image.removeAttribute('data-mailflow-remote-blocked');
    } else {
      image.setAttribute('data-mailflow-remote-src', normalizedSrc);
      image.setAttribute('data-mailflow-remote-blocked', 'true');
      if (/^(?:https?:)?\/\//i.test(currentSrc)) image.removeAttribute('src');
      image.removeAttribute('srcset');
    }
  }
  let output = template.innerHTML;
  if (!remoteImages) {
    output = output
      .replace(/url\s*\(\s*["']?https?:[^)]+\)/gi, 'none')
      .replace(/url\s*\(\s*["']?\/\/[^)]+\)/gi, 'none');
  }
  return output;
}


export function escapeMessageText(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${EMAIL_BASE_TAG}
<style>
  /* Shared MessagePane/ConversationReader mobile fit contract. Never hide overflow:
     an oversized legacy newsletter must reflow or remain horizontally accessible. */
  html { margin: 0; padding: 0; max-width: 100%; overflow-x: auto; box-sizing: border-box; }
  body { margin: 0; padding: 8px; max-width: 100%; box-sizing: border-box; word-wrap: break-word; overflow-wrap: anywhere; }
  *, *::before, *::after { box-sizing: border-box; }
  img, svg, video, canvas { max-width: 100%; height: auto; }
  table { max-width: 100%; width: auto; }
  td, th { max-width: 100%; overflow-wrap: anywhere; }
  pre, code { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  a { color: inherit; overflow-wrap: anywhere; word-break: break-word; }
  blockquote { max-width: 100%; margin-left: 1em; border-left: 3px solid var(--border, #ddd); padding-left: 1em; color: inherit; opacity: 0.8; }
  pre[data-mailflow-plain-text] { white-space: pre-wrap; margin: 0; font: inherit; }
  .mailflow-quote-collapsed { display: none !important; }
  .mailflow-quote-toggle { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; margin: 8px 0; padding: 2px 9px; border: 1px solid #c7c7c7; border-radius: 999px; background: #f3f3f3; color: #555; font: 12px/1.5 system-ui, sans-serif; cursor: pointer; }
  .mailflow-quote-toggle:hover { background: #e8e8e8; }
  .mailflow-quote-toggle:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 2px; }
</style>
</head><body>${html}</body></html>`;
}
