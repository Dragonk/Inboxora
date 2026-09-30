import { useEffect, type RefObject } from 'react';
import DOMPurify from 'dompurify';

let mermaidConfigured = false;
let nextDiagramId = 1;

function unsafeMermaidDirective(source: string) {
  return source.length > 20000 || source.includes(String.fromCharCode(92)) || /url\s*\(|@import|\bimg\s*:/i.test(source) || /^\s*---/.test(source) || /%%\{\s*(?:init|config)\s*:/im.test(source);
}

export function useMermaidEnhancer(rootRef: RefObject<HTMLElement>, html: string): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
    if (!blocks.length) return;

    void import('mermaid').then(async ({ default: mermaid }) => {
      if (!mermaidConfigured) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          flowchart: { htmlLabels: false },
          maxTextSize: 20000, maxEdges: 500,
        });
        mermaidConfigured = true;
      }
      for (const code of blocks) {
        if (cancelled || unsafeMermaidDirective(code.textContent || '')) continue;
        const id = `inboxora-ai-mermaid-${nextDiagramId++}`;
        try {
          const { svg } = await mermaid.render(id, code.textContent || '');
          if (cancelled || !code.isConnected) continue;
          const diagram = document.createElement('div');
          diagram.className = 'ai-mermaid';
          diagram.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: false, html: false },
            FORBID_TAGS: ['foreignObject', 'script', 'image', 'feImage', 'a'],
            FORBID_ATTR: ['onclick', 'onload', 'onerror'],
          });
          code.parentElement?.replaceWith(diagram);
        } catch {
          // Invalid diagrams remain as their already-sanitized code fence.
        }
      }
    }).catch(() => {
      // Mermaid is optional at runtime; preserve the readable source fence on load failure.
    });
    return () => { cancelled = true; };
  }, [html, rootRef]);
}
