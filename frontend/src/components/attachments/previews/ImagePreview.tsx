import PreviewAction from '../PreviewAction.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const section = useRef<HTMLElement>(null); const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(true); const [bounds, setBounds] = useState({ width: 800, height: 600 });
  const alive = useRef(new AbortController());
  useEffect(() => { alive.current = new AbortController(); return () => alive.current.abort(); }, []);
  const state = usePreviewResource(async signal => { const blob = await imageBlob(file.blob, kind, signal); const image = await loadImage(blob, signal);
    const size = { width: image.naturalWidth, height: image.naturalHeight }; image.src = ''; return { blob, ...size }; }, [file.blob, kind]);
  const url = useBlobUrl(state.value?.blob);
  useEffect(() => { const node = section.current; if (url && node?.closest('.attachment-surface') === document.activeElement) node.focus(); }, [url]);
  const natural = state.value || { width: 1, height: 1 };
  const width = rotation % 180 ? natural.height : natural.width; const height = rotation % 180 ? natural.width : natural.height;
  const actualScale = fit ? Math.max(.01, Math.min(1, (bounds.width - 24) / width, (bounds.height - 24) / height)) : zoom;
  const scale = useCallback((amount: number) => { setFit(false); setZoom(Math.min(4, Math.max(.25, actualScale + amount))); }, [actualScale]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(resize); observer.observe(element); resize(); return () => observer.disconnect();
  }, [url]);
  useEffect(() => {
    const element = section.current?.querySelector('.attachment-image-canvas'); if (!element) return;
    const wheel = (event: Event) => { if (event instanceof WheelEvent && event.ctrlKey) { event.preventDefault(); scale(event.deltaY < 0 ? .1 : -.1); } };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [url, scale]);
  const copy = async () => {
    if (!state.value) return;
    try { const png = await imagePng(state.value.blob, alive.current.signal, false, rotation); alive.current.signal.throwIfAborted(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); if (!alive.current.signal.aborted) setStatus('done'); }
    catch { if (!alive.current.signal.aborted) setStatus('failed'); }
  };
  const print = async () => {
    if (!state.value) return;
    try { await printImages([await imagePng(state.value.blob, alive.current.signal, false, rotation)], alive.current.signal); }
    catch { if (!alive.current.signal.aborted) setStatus('failed'); }
  };
  return <section ref={section} tabIndex={-1} className="attachment-image" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); void print(); return; }
    if (editingTarget(event.target)) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); scale(.25); }
    if (event.key === '-') { event.preventDefault(); scale(-.25); }
    if (event.key === '0') { event.preventDefault(); setFit(true); }
  }}>
    <div className="attachment-toolbar">
      <Button aria-label={t('attachment.preview.zoomOut')} onClick={() => scale(-.25)}>−</Button><span>{Math.round(actualScale * 100)}%</span><Button aria-label={t('attachment.preview.zoomIn')} onClick={() => scale(.25)}>+</Button>
      <PreviewAction icon="fitPage" label={t('attachment.preview.fit')} tooltip={t('attachment.tips.fitPage')} onClick={() => { setFit(true); }} />
      <PreviewAction icon="rotateLeft" label={t('attachment.preview.rotateLeft')} onClick={() => setRotation(value => (value + 270) % 360)} /><PreviewAction icon="rotateRight" label={t('attachment.preview.rotateRight')} onClick={() => setRotation(value => (value + 90) % 360)} />
      <PreviewAction icon="copy" label={t('attachment.preview.copyImage')} onClick={() => void copy()} disabled={!url} /><PreviewAction icon="print" label={t('attachment.preview.print')} tooltip={t('attachment.tips.print')} onClick={() => void print()} disabled={!url} />
    </div>
    {status && <p role="status">{status === 'done' ? t('attachment.preview.firstFrameCopied') : t('attachment.preview.clipboardError')}</p>}
    {url ? <div ref={viewport} className="attachment-image-canvas"><div className="attachment-image-stage" style={{ width: width * actualScale, height: height * actualScale }}><img alt={file.filename} src={url} style={{ width: natural.width * actualScale, height: natural.height * actualScale, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }} /></div></div> : <PreviewStatus loading={state.loading} error={state.error} />}
  </section>;
}
