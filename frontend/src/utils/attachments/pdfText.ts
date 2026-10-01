import { findMatches } from './find.ts';
/** Offsets shared by PDF search and the selectable text layer. */
export function pdfTextIndex(items: readonly { str: string; hasEOL?: boolean }[]) {
  let text = '';
  const segments = items.map(item => {
    const start = text.length; text += item.str;
    const end = text.length; text += item.hasEOL ? '\n' : ' ';
    return { start, end };
  });
  return { text, segments };
}

/** Paint translucent rectangles without changing PDF.js glyph spans or selection. */
export function paintPdfMatches(target: HTMLElement, spans: HTMLElement[], index: ReturnType<typeof pdfTextIndex>, query: string, active?: { start: number; end: number }): void {
  target.replaceChildren();
  const bounds = target.getBoundingClientRect();
  const sx = bounds.width / target.offsetWidth; const sy = bounds.height / target.offsetHeight;
  if (!query || !sx || !sy) return;
  let cursor = 0; let selected: HTMLElement | undefined;
  for (const hit of findMatches(index.text, query)) {
    while (cursor < index.segments.length && index.segments[cursor].end <= hit.start) cursor++;
    for (let i = cursor; i < index.segments.length && index.segments[i].start < hit.end; i++) {
      const segment = index.segments[i]; const text = spans[i]?.firstChild;
      const start = Math.max(hit.start, segment.start); const end = Math.min(hit.end, segment.end);
      if (start >= end || !text || !spans[i].isConnected) continue;
      const range = target.ownerDocument.createRange();
      range.setStart(text, start - segment.start); range.setEnd(text, end - segment.start);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const mark = target.ownerDocument.createElement('i'); mark.className = 'attachment-pdf-hit';
        const current = hit.start === active?.start && hit.end === active.end;
        mark.dataset.currentMatch = String(current);
        Object.assign(mark.style, { left: `${(rect.left - bounds.left) / sx}px`, top: `${(rect.top - bounds.top) / sy}px`, width: `${rect.width / sx}px`, height: `${rect.height / sy}px` });
        target.append(mark); if (current && !selected) selected = mark;
      }
    }
  }
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
