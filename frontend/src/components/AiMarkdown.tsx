import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../utils/renderMarkdown.ts';

let mermaidConfigured = false;
let nextDiagramId = 1;

function unsafeMermaidDirective(source: string) {
  return /^\s*%%\{\s*(?:init|config)\s*:/im.test(source);
}

/** Render AI Markdown and progressively enhance fenced Mermaid blocks.
 * Model output is untrusted: normal Markdown and generated SVG are sanitized separately. */
export default function AiMarkdown({ markdown }: { markdown: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);

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
            FORBID_TAGS: ['foreignObject', 'script'],
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
  }, [html]);

  return <div ref={rootRef} className="ai-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
