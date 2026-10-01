import { useEffect, useRef, useState } from 'react';
import { detectKind, isImageKind } from '../../utils/attachments/attachmentKind.ts';
import { imageBlob, imagePng } from '../../utils/attachments/image.ts';
import type { ArchiveEntry, ArchiveSession } from '../../utils/attachments/archiveBrowser.ts';
import { withArchiveThumbnail } from '../../utils/attachments/archiveBrowser.ts';
import { usePreviewResource, useBlobUrl } from './usePreviewResource.ts';
import { PreviewSymbol } from './PreviewAction.tsx';

export default function ArchiveThumbnail({ entry, session, enabled }: { entry: ArchiveEntry; session: ArchiveSession; enabled: boolean }) {
  const root = useRef<HTMLSpanElement>(null); const [visible, setVisible] = useState(false);
  const kind = detectKind(entry.name); const image = !entry.directory && !entry.encrypted && isImageKind(kind);
  useEffect(() => {
    const node = root.current; if (!node || !enabled || !image) return;
    const observer = new IntersectionObserver(items => setVisible(items.some(item => item.isIntersecting)));
    observer.observe(node); return () => observer.disconnect();
  }, [enabled, image]);
  const state = usePreviewResource(async signal => {
    if (!enabled || !visible || !image) return undefined;
    return withArchiveThumbnail(signal, async () => {
      const raw = await session.read(entry, signal, true);
      return imagePng(await imageBlob(raw, kind, signal), signal, 128);
    });
  }, [entry.name, enabled, visible, session]);
  const url = useBlobUrl(state.value);
  return <span ref={root} className="attachment-archive-thumbnail" aria-hidden="true">
    {url ? <img src={url} alt="" /> : <PreviewSymbol icon={entry.directory ? 'folder' : image ? 'image' : 'file'} />}
  </span>;
}
