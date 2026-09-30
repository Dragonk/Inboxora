import { useEffect, useRef, useState, type ReactNode } from 'react';
import { acquireAttachment } from '../../utils/attachments/fetchAttachment.ts';
import { detectKind, isImageKind } from '../../utils/attachments/attachmentKind.ts';
import { imageBlob, imagePng } from '../../utils/attachments/image.ts';
import { useBlobUrl } from './usePreviewResource.ts';
let thumbnailQueue = Promise.resolve();
/** Serialize small thumbnail jobs so a visible row cannot reserve the entire blob budget. */
export default function AttachmentThumbnail({ path, filename, type, epoch, children }: { path?: string; filename?: string; type?: string; epoch: number; children: ReactNode }) {
  const element = useRef<HTMLSpanElement>(null); const [visible, setVisible] = useState(false); const [thumbnail, setThumbnail] = useState<Blob>();
  const url = useBlobUrl(thumbnail); const candidate = isImageKind(detectKind(filename || '', type));
  useEffect(() => {
    if (!element.current || !candidate || !path) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } });
    observer.observe(element.current); return () => observer.disconnect();
  }, [candidate, path]);
  useEffect(() => {
    if (!visible || !path) return;
    const controller = new AbortController(); setThumbnail(undefined);
    const job = async () => {
      if (controller.signal.aborted) return;
      const lease = acquireAttachment(path, epoch); controller.signal.addEventListener('abort', lease.release, { once: true });
      try {
        const blob = await lease.promise; controller.signal.throwIfAborted();
        const kind = detectKind(filename || '', type, new Uint8Array(await blob.slice(0, 4096).arrayBuffer()));
        if (!isImageKind(kind)) return;
        const image = await imageBlob(blob, kind, controller.signal); const png = await imagePng(image, controller.signal, true);
        if (!controller.signal.aborted) setThumbnail(png);
      } finally { controller.signal.removeEventListener('abort', lease.release); lease.release(); }
    };
    // A failed optional thumbnail leaves the file icon and normal preview/download actions intact.
    thumbnailQueue = thumbnailQueue.then(job).catch(() => undefined);
    return () => controller.abort();
  }, [visible, path, filename, type, epoch]);
  return <span ref={element} className={url ? 'attachment-thumbnail' : undefined}>{url ? <img alt="" src={url} width={48} height={48} /> : children}</span>;
}
