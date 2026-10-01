import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { useBlobUrl } from '../usePreviewResource.ts';
export default function MediaPreview({ file, kind }: { file: PreviewFile; kind: string }) {
  const { t } = useTranslation(); const url = useBlobUrl(file.blob); const [failed, setFailed] = useState(false);
  return <section className="attachment-media">{failed ? <p role="alert">{t('attachment.preview.codecUnavailable')}</p>
    : kind === 'video' ? <video src={url} controls preload="metadata" playsInline aria-label={file.filename} onError={() => setFailed(true)} />
      : <audio src={url} controls preload="metadata" aria-label={file.filename} onError={() => setFailed(true)} />}</section>;
}
