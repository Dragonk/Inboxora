import { useEffect, type RefObject } from 'react';
import DOMPurify from 'dompurify';
import { useStore } from '../store/index.ts';
import { getEmailSurface } from '../themes.ts';

let rendering = Promise.resolve();
let nextDiagramId = 1;

function unsafeMermaidDirective(source: string) {
  return source.length > 20000 || source.includes(String.fromCharCode(92)) || /url\s*\(|@import|\bimg\s*:/i.test(source) || /^\s*---/.test(source) || /%%\{\s*(?:init|config)\s*:/im.test(source);
}

export function useMermaidEnhancer(rootRef: RefObject<HTMLElement>, html: string): void {
  const theme = useStore(state => state.theme);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    if (root.querySelector('.ai-mermaid')) root.innerHTML = html;
    const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
    if (!blocks.length) return;

    void import('mermaid').then(async ({ default: mermaid }) => {
      for (const code of blocks) {
        if (cancelled || unsafeMermaidDirective(code.textContent || '')) continue;
        const id = `inboxora-ai-mermaid-${nextDiagramId++}`;
        try {
          let svg = '';
          const operation = rendering.then(async () => {
            if (cancelled || !code.isConnected) return;
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
              theme: getEmailSurface(theme)?.tone === 'dark' ? 'dark' : 'default',
              flowchart: { htmlLabels: false }, maxTextSize: 20000, maxEdges: 500 });
            svg = (await mermaid.render(id, code.textContent || '')).svg;
          });
          rendering = operation.catch(() => undefined);
          await operation;
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
  }, [html, rootRef, theme]);
}
