import { nativePreviewBlob, openNativePreview } from '../../utils/attachments/nativeWindow.ts';
import { ensurePreviewSafe, scanBlocked, sourceScanWarning } from '../../utils/attachments/safety.ts';
import PreviewAction from './PreviewAction.tsx';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import { isDangerousAttachment } from '../../utils/dangerousAttachment.ts';
import { acquireAttachment, attachmentPath, downloadBlob, fetchOriginalAttachment } from '../../utils/attachments/fetchAttachment.ts';
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
  else if (kind === 'zip' || kind === 'archive') content = <ArchivePreview file={file} server={kind === 'archive'} onOpen={onOpen} />;
  else if (kind === 'html') content = <HtmlPreview file={file} />;
  else if (kind === 'eml') content = <EmlPreview file={file} onDownload={onDownload} />;
  else if (kind === 'audio' || kind === 'video') content = <MediaPreview file={file} kind={kind} />;
  else if (kind === 'ics' || kind === 'vcf') content = <IcsVcfPreview file={file} kind={kind} />;
  else if (kind === 'unsupported') content = <PreviewStatus error="UNSUPPORTED" />;
  else content = <TextPreview file={file} kind={kind} />;
  return <PreviewBoundary key={`${file.filename}:${kind}`}><Suspense fallback={<PreviewStatus loading />}>{content}</Suspense></PreviewBoundary>;
}
export default function AttachmentPreviewSurface({ selection, onSelect, onDetach, onClose, onFullscreen, onMinimize, escapeRef, localFiles }: {
  selection: AttachmentSelection; onSelect: (index: number) => void; onDetach?: () => void; onClose?: () => void;
  onFullscreen?: () => void; onMinimize?: () => void;
  escapeRef?: MutableRefObject<() => void>;
  localFiles?: ReadonlyMap<string, () => Promise<Blob>>;
}) {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch); const index = selection.index;
  const [stack, setStack] = useState<PreviewFile[]>([]); const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [pending, setPending] = useState<PreviewFile | 'all' | 'original' | null>(null); const root = useRef<HTMLDivElement>(null);
  const source = selection.attachments[index];
  const downloadRequest = useRef<AbortController>(); const [downloading, setDownloading] = useState(false); const [downloadFailed, setDownloadFailed] = useState(false);
  useEffect(() => {
    setDownloading(false); setDownloadFailed(false);
    return () => { downloadRequest.current?.abort(); };
  }, [source?.path, selection.authEpoch]);
  const state = usePreviewResource(async signal => {
    setStack([]); setProgress({ loaded: 0, total: 0 });
    if (!source || !isCurrentAuthEpoch(selection.authEpoch)) throw new DOMException('Preview cancelled', 'AbortError');
    if ((source.size || 0) > PREVIEW_LIMIT) throw new Error('LIMIT');
    const local = localFiles?.get(source.path);
    if (local) {
      const blob = await local(); signal.throwIfAborted();
      return { filename: source.filename, type: source.type, blob, budget: { expanded: 0 }, depth: 0 } satisfies PreviewFile;
    }
    const lease = acquireAttachment(source.path, selection.authEpoch, (loaded, total) => { if (!signal.aborted) setProgress({ loaded, total }); });
    signal.addEventListener('abort', lease.release, { once: true });
    const blob = await lease.promise; signal.throwIfAborted();
    return { filename: source.filename, type: source.type, blob, budget: { expanded: 0 }, depth: 0 } satisfies PreviewFile;
  }, [source?.path, source?.filename, source?.type, source?.size, selection.authEpoch, localFiles]);
  const file = state.loading ? undefined : stack.at(-1) || state.value;
  const approval = usePreviewResource(async signal => file ? await ensurePreviewSafe(file.blob, signal) : false, [file?.blob]);
  const native = usePreviewResource(async signal => file && approval.value ? nativePreviewBlob(file, signal) : undefined, [file?.blob, approval.value]);
  const blocked = scanBlocked(state.error) || scanBlocked(approval.error);
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
  const original = async () => {
    if (!source || !isCurrentAuthEpoch(selection.authEpoch) || downloadRequest.current && !downloadRequest.current.signal.aborted) return;
    const controller = new AbortController(); downloadRequest.current = controller; setDownloading(true); setDownloadFailed(false);
    try {
      const local = localFiles?.get(source.path);
      const blob = local ? await local() : await fetchOriginalAttachment(source.path, selection.authEpoch, controller.signal);
      controller.signal.throwIfAborted();
      if (isCurrentAuthEpoch(selection.authEpoch)) downloadBlob(blob, source.filename);
    } catch { if (!controller.signal.aborted && isCurrentAuthEpoch(selection.authEpoch)) setDownloadFailed(true); }
    finally { if (downloadRequest.current === controller) { downloadRequest.current = undefined; if (!controller.signal.aborted) setDownloading(false); } }
  };
  const requestOriginal = () => { if (source && (blocked || isDangerousAttachment(source))) setPending('original'); else original(); };
  const download = (target: PreviewFile) => { if (!isCurrentAuthEpoch(selection.authEpoch)) return; if (blocked || isDangerousAttachment(target)) setPending(target); else downloadBlob(target.blob, target.filename); };
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
      <span data-window-drag className="attachment-filename" title={file?.filename || source?.filename}>{file?.filename || source?.filename}</span>
      <span className="attachment-size">{t('attachment.preview.bytes', { size: file?.blob.size || source?.size || 0 })}</span>
      <PreviewAction icon="download" disabled={downloading || (!!file && approval.loading)} label={t('attachment.preview.download')} tooltip={t('attachment.tips.download')} onClick={() => file ? download(file) : requestOriginal()} />
      {selection.downloadAllPath && <PreviewAction icon="downloadAll" label={t('message.downloadAll')} tooltip={t('attachment.tips.downloadAll')} onClick={() => (blocked || selection.downloadAllDangerous || selection.attachments.some(item => sourceScanWarning(item.path))) ? setPending('all') : all()} />}
      {native.value && approval.value && <PreviewAction icon="external" label={t('attachment.preview.openNative')} tooltip={t('attachment.tips.openNative')} onClick={() => { if (native.value) openNativePreview(native.value, selection.authEpoch); }} />}
      {onDetach && !stack.length && <PreviewAction icon="detached" label={t('attachment.preview.openWindow')} tooltip={t('attachment.tips.openWindow')} onClick={onDetach} />}
      {onMinimize && <PreviewAction icon="minimize" label={t('window.minimize')} onClick={onMinimize} />}
      {onFullscreen && <PreviewAction icon="fullscreen" label={t('attachment.preview.fullscreen')} onClick={onFullscreen} />}
      {onClose && <PreviewAction icon="close" label={t('common.close')} onClick={onClose} />}
    </div>
    {gallery && <nav className="attachment-gallery" aria-label={t('attachment.preview.gallery')}>
      <Button aria-label={t('attachment.preview.previousImage')} onClick={() => move(-1)}>‹</Button>
      {images.map(item => <button key={item.position} type="button" aria-label={item.attachment.filename} aria-current={item.position === index} onClick={() => onSelect(item.position)}>{item.position === index ? '●' : '○'}</button>)}
      <Button aria-label={t('attachment.preview.nextImage')} onClick={() => move(1)}>›</Button>
    </nav>}
    {downloadFailed && <p role="alert">{t('common.error', { message: t('attachment.preview.download') })}</p>}
    {state.loading && progress.loaded > 0 && <p role="status">{t('attachment.preview.loadingBytes', { loaded: progress.loaded, total: progress.total || source?.size || 0 })}</p>}
    <div className="attachment-content">{file && approval.value ? <PreviewContent key={`${index}:${stack.length}:${file.blob.size}`} file={file} onOpen={nested => setStack(value => [...value, nested])} onDownload={download} /> : <PreviewStatus loading={state.loading || (!!file && approval.loading)} error={state.error || approval.error} />}</div>
    {pending && <Dialog backPriority={4600} title={t('message.dangerousAttachment.title')} closeLabel={t('common.close')} onClose={() => setPending(null)} testId="attachment-dangerous-dialog"
      footer={<><Button onClick={() => setPending(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => { const target = pending; setPending(null); if (!isCurrentAuthEpoch(selection.authEpoch)) return; if (target === 'all') all(); else if (target === 'original') original(); else downloadBlob(target.blob, target.filename); }}>{t('message.dangerousAttachment.download')}</Button></>}>
      <p>{blocked ? t('attachment.security.downloadWarning') : t('message.dangerousAttachment.body')}</p>
    </Dialog>}
  </div>;
}
