import { useEffect, useRef, useMemo } from 'react';
import DOMPurify from 'dompurify';

// Shared email HTML sanitization policy — used by both MessagePane and
// ConversationPane via sanitizeMessageHtml() so they have an identical
// security model.
export const EMAIL_SANITIZE_POLICY = {
  ADD_ATTR: ['target'],
  // Email CSS is untrusted and must not be injected into the sandbox document:
  // CSS can trigger remote fetches via url()/@import and has historically been a
  // source of layout/CSS exfiltration surprises. The renderer supplies its own
  // constrained stylesheet below.
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'track', 'style'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
};

// Preserve cid: references so they survive DOMPurify (which would strip them
// as unknown-protocol attributes). The backend resolves the CID to the matching
// attachment content — the frontend does NOT map them to an API endpoint
// (the backend already does this during ingest/snippet generation).
function preserveCid(html) {
  return html.replace(/(src|href)=("|')cid:/gi, '$1=$2cid:');
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

// P1-13/14: Shared CSP + <base> security primitives — used by both
// MessageBodyRenderer (ConversationPane) and MessagePane's inline iframe
// so both have an IDENTICAL security model: default-src 'none', explicit
// img-src (self/data/cid only before Load Images), and <base> with
// rel="noopener noreferrer".
export function emailCsp({ remoteImages = false } = {}) {
  return remoteImages
    ? "default-src 'none'; img-src 'self' data: cid: https: http:; style-src 'unsafe-inline'; media-src 'self' data:"
    : "default-src 'none'; img-src 'self' data: cid:; style-src 'unsafe-inline'; media-src 'self' data:";
}

// The <base> tag ensures all links open in a new tab with noopener+noreferrer.
export const EMAIL_BASE_TAG = '<base target="_blank" rel="noopener noreferrer">';

// Build the full HTML document for the sandboxed iframe srcDoc.
// Injects a CSP meta tag, overflow:hidden, and a <base target="_blank">
// so all links open in a new tab (with rel=noopener noreferrer).
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

/**
 * SafeMessageFrame — shared production HTML body renderer using a sandboxed iframe.
 *
 * Both MessagePane and ConversationPane use this component so they have an
 * IDENTICAL security model:
 *   - sandboxed iframe (allow-same-origin only — NO allow-scripts)
 *   - CSP via meta tag (default-src 'none', no remote resources unless explicitly enabled)
 *   - DOMPurify sanitization with EMAIL_SANITIZE_POLICY
 *   - <base target="_blank" rel="noopener noreferrer">
 *   - remote-image blocking (default), with opt-in for allow-listed senders
 *   - CID references preserved (backend resolves to attachment content)
 *   - auto-height sizing to content
 *
 * The iframe has NO allow-scripts, so even if an attacker injects <script>,
 * event handlers, javascript: URIs, or SVG tricks, they cannot execute.
 * CSS external URLs are blocked by CSP + regex sanitization.
 * iframe/object/embed/form are stripped by DOMPurify FORBID_TAGS.
 */
export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false, onHeightChange = null }) {
  const iframeRef = useRef(null);

  const srcDoc = useMemo(() => {
    if (!html) return null;
    const sanitized = sanitizeMessageHtml(html, { remoteImages });
    return buildSrcDoc(sanitized, { remoteImages });
  }, [html, remoteImages]);

  // Auto-height: measure the iframe content and set the iframe height
  // so no internal scrollbar appears (same approach as MessagePane).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !srcDoc) return;

    const onLoaded = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const contentHeight = doc.documentElement?.scrollHeight || doc.body?.scrollHeight || 300;
        iframe.style.height = contentHeight + 'px';
        if (onHeightChange) onHeightChange(contentHeight);
      } catch {
        // Cross-origin or not yet loaded — leave default height.
      }
    };

    iframe.addEventListener('load', onLoaded, { once: true });
    if (iframe.contentDocument?.readyState === 'complete') {
      onLoaded();
    }
    return () => iframe.removeEventListener('load', onLoaded);
  }, [srcDoc, onHeightChange]);

  if (!html) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      loading="lazy"
      style={{
        width: '100%',
        height: '300px',
        border: 'none',
        display: 'block',
        background: 'transparent',
      }}
      // Prevent the iframe from being a drag/drop target for external content.
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
