import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { imageBlob, imagePng, loadImage } from '../../../utils/attachments/image.ts';
import { Button } from '../../ui.tsx';
import { useBlobUrl, usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
import { editingTarget } from '../shortcuts.ts';
import { printImages } from '../print.ts';
export default function ImagePreview({ file, kind }: { file: PreviewFile; kind: string }) {
  const { t } = useTranslation(); const [zoom, setZoom] = useState(1); const [rotation, setRotation] = useState(0); const [status, setStatus] = useState<'done' | 'failed' | null>(null);
  const section = useRef<HTMLElement>(null);
  const alive = useRef(new AbortController());
  useEffect(() => { alive.current = new AbortController(); return () => alive.current.abort(); }, []);
  const state = usePreviewResource(async signal => { const result = await imageBlob(file.blob, kind, signal); await loadImage(result, signal); return result; }, [file.blob, kind]);
  const url = useBlobUrl(state.value);
  useEffect(() => { const node = section.current; if (url && node?.closest('.attachment-surface') === document.activeElement) node.focus(); }, [url]);
  const scale = (amount: number) => setZoom(value => Math.min(4, Math.max(0.25, value + amount)));
  useEffect(() => {
    const element = section.current?.querySelector('.attachment-image-canvas'); if (!element) return;
    const wheel = (event: Event) => { if (event instanceof WheelEvent && event.ctrlKey) { event.preventDefault(); scale(event.deltaY < 0 ? .1 : -.1); } };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [url]);
  const copy = async () => {
    if (!state.value) return;
    try { const png = await imagePng(state.value, alive.current.signal); alive.current.signal.throwIfAborted(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); if (!alive.current.signal.aborted) setStatus('done'); }
    catch { if (!alive.current.signal.aborted) setStatus('failed'); }
  };
  const print = async () => {
    if (!state.value) return;
    try { await printImages([await imagePng(state.value, alive.current.signal)], alive.current.signal); }
    catch { if (!alive.current.signal.aborted) setStatus('failed'); }
  };
  return <section ref={section} tabIndex={-1} className="attachment-image" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); void print(); return; }
    if (editingTarget(event.target)) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); scale(.25); }
    if (event.key === '-') { event.preventDefault(); scale(-.25); }
    if (event.key === '0') { event.preventDefault(); setZoom(1); setRotation(0); }
  }}>
    <div className="attachment-toolbar">
      <Button aria-label={t('attachment.preview.zoomOut')} onClick={() => scale(-.25)}>−</Button><span>{Math.round(zoom * 100)}%</span><Button aria-label={t('attachment.preview.zoomIn')} onClick={() => scale(.25)}>+</Button>
      <Button onClick={() => { setZoom(1); setRotation(0); }}>{t('attachment.preview.fit')}</Button>
      <Button onClick={() => setRotation(value => (value + 90) % 360)}>{t('attachment.preview.rotate')}</Button>
      <Button onClick={() => void copy()} disabled={!url}>{t('attachment.preview.copyImage')}</Button><Button onClick={() => void print()} disabled={!url}>{t('attachment.preview.print')}</Button>
    </div>
    {status && <p role="status">{status === 'done' ? t('attachment.preview.firstFrameCopied') : t('attachment.preview.clipboardError')}</p>}
    {url ? <div className="attachment-image-canvas"><img alt={file.filename} src={url} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} /></div> : <PreviewStatus loading={state.loading} error={state.error} />}
  </section>;
}
