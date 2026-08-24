import { useEffect, useRef, useMemo } from 'react';
export { EMAIL_SANITIZE_POLICY, sanitizeMessageHtml, emailCsp, EMAIL_BASE_TAG, buildSrcDoc } from './messageBodySecurity.js';
import { sanitizeMessageHtml, buildSrcDoc } from './messageBodySecurity.js';

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
export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false, onHeightChange = null, iframeRef: externalIframeRef = null, onLoad = null, title = 'Message body', style: frameStyle = null }) {
  const internalIframeRef = useRef(null);
  const iframeRef = externalIframeRef || internalIframeRef;

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

    const measure = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const contentHeight = Math.max(300, doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0);
        iframe.style.height = contentHeight + 'px';
        onHeightChange?.(contentHeight);
      } catch {
        // Cross-origin or not yet loaded — leave default height.
      }
    };
    const install = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const images = [...doc.images];
      const onDocumentClick = (event) => {
        const anchor = event.target?.closest?.('a');
        if (!anchor) return;
        const raw = anchor.getAttribute('href') || '';
        let url;
        try { url = new URL(raw, window.location.href); } catch { event.preventDefault(); return; }
        if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
          event.preventDefault();
          window.open(url.href, '_blank', 'noopener,noreferrer');
        } else event.preventDefault();
      };
      doc.addEventListener('click', onDocumentClick);
      for (const image of images) {
        image.addEventListener('load', measure);
        image.addEventListener('error', measure);
      }
      let observer = null;
      if (typeof ResizeObserver !== 'undefined' && doc.body) {
        observer = new ResizeObserver(measure);
        observer.observe(doc.body);
      }
      measure();
      onLoad?.();
      return () => {
        doc.removeEventListener('click', onDocumentClick);
        for (const image of images) {
          image.removeEventListener('load', measure);
          image.removeEventListener('error', measure);
        }
        observer?.disconnect();
      };
    };
    let cleanup = null;
    const onLoaded = () => { cleanup?.(); cleanup = install() || null; };
    iframe.addEventListener('load', onLoaded);
    if (iframe.contentDocument?.readyState === 'complete') onLoaded();
    return () => {
      cleanup?.();
      iframe.removeEventListener('load', onLoaded);
    };
  }, [srcDoc, onHeightChange, onLoad, iframeRef]);

  if (!html) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      title={title}
      sandbox="allow-same-origin"
      loading="lazy"
      style={{
        width: '100%',
        height: '300px',
        border: 'none',
        display: 'block',
        background: 'transparent',
        ...frameStyle,
      }}
      // Prevent the iframe from being a drag/drop target for external content.
      // Prevent the iframe from being a drag/drop target for external content.
      onDragStart={(e) => e.preventDefault()}    />
  );
}
