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
export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false, collapseQuotes = false, onQuoteDetected = null, onHeightChange = null, iframeRef: externalIframeRef = null, onLoad = null, title = 'Message body', style: frameStyle = null }) {
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
      const expanded = new Map();
      const quoteTextRe = /^\s*(On .+ wrote:|Dnia .+ napisał|-----Original Message-----|-----Wiadomość oryginalna-----)[\s\S]*$/m;
      const detectAndApplyQuotes = () => {
        const quoteNodes = doc.querySelectorAll('blockquote, .gmail_quote, .moz-quote-container, .yahoo_quoted');
        const text = doc.body?.textContent || '';
        const hasTextQuote = quoteTextRe.test(text);
        const hasQuote = quoteNodes.length > 0 || hasTextQuote;
        onQuoteDetected?.(hasQuote);
        for (const quote of quoteNodes) quote.style.display = collapseQuotes ? 'none' : '';
        if (hasTextQuote && !doc.querySelector('[data-mailflow-text-quote]')) {
          const match = text.match(quoteTextRe);
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const index = node.nodeValue?.indexOf(match?.[1] || '');
            if (index >= 0) {
              const range = doc.createRange();
              range.setStart(node, index);
              range.setEnd(doc.body, doc.body.childNodes.length);
              const wrapper = doc.createElement('span');
              wrapper.dataset.mailflowTextQuote = 'true';
              wrapper.appendChild(range.extractContents());
              range.insertNode(wrapper);
              break;
            }
          }
        }
        const textQuote = doc.querySelector('[data-mailflow-text-quote]');
        if (textQuote) textQuote.style.display = collapseQuotes ? 'none' : '';
      };
      const expandScrollContainers = () => {
        const elements = [...doc.querySelectorAll('*')].reverse();
        for (const el of elements) {
          const style = doc.defaultView?.getComputedStyle(el);
          if (!style) continue;
          const isScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll')
            && el.scrollHeight > el.clientHeight + 2;
          if (!isScroll) continue;
          if (!expanded.has(el)) {
            expanded.set(el, {
              overflowY: el.style.getPropertyValue('overflow-y'),
              overflowYPriority: el.style.getPropertyPriority('overflow-y'),
              height: el.style.getPropertyValue('height'),
              heightPriority: el.style.getPropertyPriority('height'),
              maxHeight: el.style.getPropertyValue('max-height'),
              maxHeightPriority: el.style.getPropertyPriority('max-height'),
            });
          }
          el.style.setProperty('overflow-y', 'hidden', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('height', `${el.scrollHeight}px`, 'important');
        }
      };
      const restoreScrollContainers = () => {
        for (const [el, previous] of expanded) {
          for (const [name, value, priority] of [
            ['overflow-y', previous.overflowY, previous.overflowYPriority],
            ['height', previous.height, previous.heightPriority],
            ['max-height', previous.maxHeight, previous.maxHeightPriority],
          ]) {
            if (value) el.style.setProperty(name, value, priority);
            else el.style.removeProperty(name);
          }
        }
        expanded.clear();
      };
      const measureExpanded = () => {
        detectAndApplyQuotes();
        expandScrollContainers();
        measure();
      };
      const images = [...doc.images];
      const onDocumentClick = (event) => {
        const anchor = event.target?.closest?.('a');
        if (!anchor) return;
        const raw = anchor.getAttribute('href') || '';
        let url;
        try { url = new URL(raw, window.location.href); } catch { event.preventDefault(); return; }
        if (url.protocol === 'https:' || url.protocol === 'mailto:') {
          event.preventDefault();
          window.open(url.href, '_blank', 'noopener,noreferrer');
        } else event.preventDefault();
      };
      doc.addEventListener('click', onDocumentClick);
      for (const image of images) {
        image.addEventListener('load', measureExpanded);
        image.addEventListener('error', measureExpanded);
      }
      let observer = null;
      if (typeof ResizeObserver !== 'undefined' && doc.body) {
        observer = new ResizeObserver(measureExpanded);
        observer.observe(doc.body);
      }
      measureExpanded();
      onLoad?.();
      return () => {
        doc.removeEventListener('click', onDocumentClick);
        for (const image of images) {
          image.removeEventListener('load', measureExpanded);
          image.removeEventListener('error', measureExpanded);
        }
        observer?.disconnect();
        restoreScrollContainers();
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
  }, [srcDoc, remoteImages, collapseQuotes, onQuoteDetected, onHeightChange, onLoad, iframeRef]);

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
