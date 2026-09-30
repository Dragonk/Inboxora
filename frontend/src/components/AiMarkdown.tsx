import { useMemo, useRef } from 'react';
import { useMermaidEnhancer } from '../hooks/useMermaidEnhancer.ts';
import { renderMarkdown } from '../utils/renderMarkdown.ts';

/** Render AI Markdown and progressively enhance fenced Mermaid blocks.
 * Model output is untrusted: normal Markdown and generated SVG are sanitized separately. */
export default function AiMarkdown({ markdown }: { markdown: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);

  useMermaidEnhancer(rootRef, html);

  return <div ref={rootRef} className="ai-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
