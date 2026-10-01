import { pdfTextIndex, paintPdfMatches } from '../../../utils/attachments/pdfText.ts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';

/** Offscreen pages retain only their geometry, never a full-resolution canvas. */
export default function PdfPage({ document: pdf, number, scale, rotation, base, root, thumbnail = false, query = '', activeMatch }: {
  document: PDFDocumentProxy; number: number; scale: number; rotation: number; base: { width: number; height: number };
  root?: RefObject<HTMLDivElement>; thumbnail?: boolean; query?: string; activeMatch?: { start: number; end: number };
}) {
  const { t } = useTranslation(); const element = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null); const text = useRef<HTMLDivElement>(null);
  const layout = useRef<{ spans: HTMLElement[]; index: ReturnType<typeof pdfTextIndex> }>();
  const highlights = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false); const [size, setSize] = useState(base); const [failed, setFailed] = useState(false); const [painted, setPainted] = useState(0);
  useEffect(() => {
    const node = element.current; if (!node) return;
    const observer = new IntersectionObserver(records => setVisible(records.some(record => record.isIntersecting)), { root: root?.current, rootMargin: thumbnail ? '100px' : '400px' });
    observer.observe(node); return () => observer.disconnect();
  }, [root, thumbnail]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false; let task: RenderTask | undefined; let layer: TextLayer | undefined;
    const highlightTarget = highlights.current;
    const target = canvas.current; const textTarget = text.current; if (!target) return;
    setFailed(false);
    void pdf.getPage(number).then(async page => {
      if (cancelled) return;
      const normal = page.getViewport({ scale: 1 }); setSize({ width: normal.width, height: normal.height });
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const ratio = Math.min(window.devicePixelRatio || 1, thumbnail ? 1 : 2, Math.sqrt(12 * 1024 * 1024 / (viewport.width * viewport.height)));
      if (!Number.isFinite(ratio) || ratio <= 0 || viewport.width > 32768 || viewport.height > 32768) throw new Error('LIMIT');
      target.width = Math.max(1, Math.floor(viewport.width * ratio)); target.height = Math.max(1, Math.floor(viewport.height * ratio));
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`;
      task = page.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await task.promise; if (cancelled) return;
      if (textTarget && !thumbnail) {
        textTarget.replaceChildren();
        const content = await page.getTextContent(); if (cancelled) return;
        layer = new TextLayer({ textContentSource: content, container: textTarget, viewport });
        await layer.render(); if (cancelled) return;
        layout.current = { spans: layer.textDivs, index: pdfTextIndex(content.items.filter(item => 'str' in item)) };
      }
      if (!cancelled) setPainted(value => value + 1);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; task?.cancel(); layer?.cancel(); target.width = 0; target.height = 0; textTarget?.replaceChildren(); highlightTarget?.replaceChildren(); layout.current = undefined; };
  }, [pdf, number, visible, scale, rotation, thumbnail]);
  useEffect(() => {
    if (highlights.current && layout.current && visible) {
      paintPdfMatches(highlights.current, layout.current.spans, layout.current.index, query, activeMatch);
    }
  }, [query, painted, visible, activeMatch]);
  const swapped = rotation % 180 !== 0;
  const width = (swapped ? size.height : size.width) * scale; const height = (swapped ? size.width : size.height) * scale;
  return <div ref={element} className="attachment-pdf-page" data-pdf-page={thumbnail ? undefined : number} data-pdf-rendered={visible} style={{ width, height, '--scale-factor': scale, '--total-scale-factor': scale } as CSSProperties}>
    {visible && <><canvas ref={canvas} aria-label={t('attachment.preview.page', { page: number, total: pdf.numPages })} />{!thumbnail && <><div ref={text} className="textLayer" /><div ref={highlights} className="attachment-pdf-highlights" aria-hidden="true" /></>}</>}
    {failed && <p role="alert">{t('attachment.preview.failed')}</p>}
  </div>;
}
