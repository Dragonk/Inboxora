import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import { isDangerousAttachment } from '../../utils/dangerousAttachment.ts';
import { acquireAttachment, attachmentPath, downloadBlob } from '../../utils/attachments/fetchAttachment.ts';
import { detectKind, isImageKind } from '../../utils/attachments/attachmentKind.ts';
import { PREVIEW_LIMIT, type AttachmentSelection, type PreviewFile } from '../../utils/attachments/types.ts';
import { useBackLayer } from '../../hooks/useBackNavigation.ts';
import { Button, Dialog } from '../ui.tsx';
import PreviewStatus from './PreviewStatus.tsx';
import { usePreviewResource } from './usePreviewResource.ts';
import { editingTarget } from './shortcuts.ts';

const ImagePreview = lazy(() => import('./previews/ImagePreview.tsx'));
const PdfPreview = lazy(() => import('./previews/PdfPreview.tsx'));
const TextPreview = lazy(() => import('./previews/TextPreview.tsx'));
const DocxPreview = lazy(() => import('./previews/DocxPreview.tsx'));
const SheetPreview = lazy(() => import('./previews/SheetPreview.tsx'));
const OfficePreview = lazy(() => import('./previews/OfficePreview.tsx'));
const ArchivePreview = lazy(() => import('./previews/ArchivePreview.tsx'));
const HtmlPreview = lazy(() => import('./previews/HtmlPreview.tsx'));
const EmlPreview = lazy(() => import('./previews/EmlPreview.tsx'));
const MediaPreview = lazy(() => import('./previews/MediaPreview.tsx'));
const IcsVcfPreview = lazy(() => import('./previews/IcsVcfPreview.tsx'));
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PreviewStatus error="CORRUPT" /> : this.props.children; }
}
function PreviewContent({ file, onOpen, onDownload }: { file: PreviewFile; onOpen: (file: PreviewFile) => void; onDownload: (file: PreviewFile) => void }) {
  const state = usePreviewResource(async signal => {
    const bytes = new Uint8Array(await file.blob.slice(0, 4096).arrayBuffer()); signal.throwIfAborted(); return detectKind(file.filename, file.type, bytes);
  }, [file.blob, file.filename, file.type]);
  const kind = state.value;
  if (!kind) return <PreviewStatus loading={state.loading} error={state.error} />;
  let content: ReactNode;
  if (isImageKind(kind)) content = <ImagePreview file={file} kind={kind} />;
  else if (kind === 'pdf') content = <PdfPreview file={file} />;
  else if (kind === 'docx') content = <DocxPreview file={file} />;
  else if (kind === 'sheet') content = <SheetPreview file={file} />;
  else if (kind === 'office') content = <OfficePreview file={file} onOpen={onOpen} />;
  else if (kind === 'zip') content = <ArchivePreview file={file} onOpen={onOpen} />;
  else if (kind === 'html') content = <HtmlPreview file={file} />;
  else if (kind === 'eml') content = <EmlPreview file={file} onDownload={onDownload} />;
  else if (kind === 'audio' || kind === 'video') content = <MediaPreview file={file} kind={kind} />;
  else if (kind === 'ics' || kind === 'vcf') content = <IcsVcfPreview file={file} kind={kind} />;
  else if (kind === 'unsupported') content = <PreviewStatus error="UNSUPPORTED" />;
  else content = <TextPreview file={file} kind={kind} />;
  return <PreviewBoundary key={`${file.filename}:${kind}`}><Suspense fallback={<PreviewStatus loading />}>{content}</Suspense></PreviewBoundary>;
}
export default function AttachmentPreviewSurface({ selection, onSelect, onDetach, onClose, escapeRef }: {
  selection: AttachmentSelection; onSelect: (index: number) => void; onDetach?: () => void; onClose?: () => void;
  escapeRef?: MutableRefObject<() => void>;
}) {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch); const index = selection.index;
  const [stack, setStack] = useState<PreviewFile[]>([]); const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [pending, setPending] = useState<PreviewFile | 'all' | 'original' | null>(null); const root = useRef<HTMLDivElement>(null);
  const source = selection.attachments[index];
  const state = usePreviewResource(async signal => {
    setStack([]); setProgress({ loaded: 0, total: 0 });
    if (!source || !isCurrentAuthEpoch(selection.authEpoch)) throw new DOMException('Preview cancelled', 'AbortError');
    if ((source.size || 0) > PREVIEW_LIMIT) throw new Error('LIMIT');
    const lease = acquireAttachment(source.path, selection.authEpoch, (loaded, total) => { if (!signal.aborted) setProgress({ loaded, total }); });
    signal.addEventListener('abort', lease.release, { once: true });
    const blob = await lease.promise; signal.throwIfAborted();
    return { filename: source.filename, type: source.type, blob, budget: { expanded: 0 }, depth: 0 } satisfies PreviewFile;
  }, [source?.path, source?.filename, source?.type, source?.size, selection.authEpoch]);
  const file = state.loading ? undefined : stack.at(-1) || state.value;
  const back = () => setStack(value => value.slice(0, -1));
  if (escapeRef) escapeRef.current = () => { if (stack.length) back(); else onClose?.(); };
  // Archive navigation is above the root preview and below password/download confirmation dialogs.
  useBackLayer(stack.length > 0 && !pending, back, 4550);
  useEffect(() => {
    const element = root.current; if (element && !element.contains(document.activeElement)) element.focus();
  }, [source?.path]);
  const all = () => {
    if (!selection.downloadAllPath || !isCurrentAuthEpoch(selection.authEpoch)) return;
    const anchor = document.createElement('a'); anchor.href = attachmentPath(selection.downloadAllPath); anchor.download = ''; document.body.append(anchor); anchor.click(); anchor.remove();
  };
  const original = () => {
    if (!source || !isCurrentAuthEpoch(selection.authEpoch)) return;
    const anchor = document.createElement('a'); anchor.href = attachmentPath(source.path); anchor.download = source.filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
  };
  const requestOriginal = () => { if (source && isDangerousAttachment(source)) setPending('original'); else original(); };
  const download = (target: PreviewFile) => { if (!isCurrentAuthEpoch(selection.authEpoch)) return; if (isDangerousAttachment(target)) setPending(target); else downloadBlob(target.blob, target.filename); };
  const images = selection.attachments.map((attachment, position) => ({ attachment, position })).filter(({ attachment }) => isImageKind(detectKind(attachment.filename, attachment.type)));
  const gallery = !stack.length && source && isImageKind(detectKind(source.filename, source.type)) && images.length > 1;
  const move = (direction: number) => { const current = images.findIndex(item => item.position === index); onSelect(images[(current + direction + images.length) % images.length].position); };
  if (epoch !== selection.authEpoch) return null;
  return <div ref={root} tabIndex={0} className="attachment-surface" data-testid="attachment-preview-surface" onKeyDown={event => {
    event.stopPropagation();
    if (!editingTarget(event.target) && gallery && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); if (stack.length) back(); else onClose?.(); }
  }}>
    <div className="attachment-toolbar attachment-main-toolbar">
      {!!stack.length && <Button onClick={back}>{t('common.back')}</Button>}
      <span className="attachment-filename" title={file?.filename || source?.filename}>{file?.filename || source?.filename}</span>
      <span className="attachment-size">{t('attachment.preview.bytes', { size: file?.blob.size || source?.size || 0 })}</span>
      <Button onClick={() => file ? download(file) : requestOriginal()}>{t('attachment.preview.download')}</Button>
      {selection.downloadAllPath && <Button onClick={() => selection.downloadAllDangerous ? setPending('all') : all()}>{t('message.downloadAll')}</Button>}
      {onDetach && !stack.length && <Button onClick={onDetach}>{t('attachment.preview.openWindow')}</Button>}
    </div>
    {gallery && <nav className="attachment-gallery" aria-label={t('attachment.preview.gallery')}>
      <Button aria-label={t('attachment.preview.previousImage')} onClick={() => move(-1)}>‹</Button>
      {images.map(item => <button key={item.position} type="button" aria-label={item.attachment.filename} aria-current={item.position === index} onClick={() => onSelect(item.position)}>{item.position === index ? '●' : '○'}</button>)}
      <Button aria-label={t('attachment.preview.nextImage')} onClick={() => move(1)}>›</Button>
    </nav>}
    {state.loading && progress.loaded > 0 && <p role="status">{t('attachment.preview.loadingBytes', { loaded: progress.loaded, total: progress.total || source?.size || 0 })}</p>}
    <div className="attachment-content">{file ? <PreviewContent key={`${index}:${stack.length}:${file.blob.size}`} file={file} onOpen={nested => setStack(value => [...value, nested])} onDownload={download} /> : <PreviewStatus loading={state.loading} error={state.error} />}</div>
    {pending && <Dialog backPriority={4600} title={t('message.dangerousAttachment.title')} closeLabel={t('common.close')} onClose={() => setPending(null)} testId="attachment-dangerous-dialog"
      footer={<><Button onClick={() => setPending(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => { const target = pending; setPending(null); if (!isCurrentAuthEpoch(selection.authEpoch)) return; if (target === 'all') all(); else if (target === 'original') original(); else downloadBlob(target.blob, target.filename); }}>{t('message.dangerousAttachment.download')}</Button></>}>
      <p>{t('message.dangerousAttachment.body')}</p>
    </Dialog>}
  </div>;
}
