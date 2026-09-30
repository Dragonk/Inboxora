import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { decodeText } from '../../../utils/attachments/decodeText.ts';
import { TEXT_LIMIT, type PreviewFile } from '../../../utils/attachments/types.ts';
import MessageBodyRenderer from '../../MessageBodyRenderer.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
export function SafeAttachmentHtml({ html, text = '' }: { html: string; text?: string }) {
  const { t } = useTranslation(); const iframe = useRef<HTMLIFrameElement>(null);
  return <div className="attachment-html"><MessageBodyRenderer iframeRef={iframe} html={html} text={text} remoteImages={false} blockAllNetwork quoteFolding={false} title={t('attachment.preview.content')}
    onFrameKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      iframe.current?.closest('.attachment-surface')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }}
    onOpenLink={url => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); }}
    style={{ width: '100%', minHeight: '100%', border: 0 }} /></div>;
}
export default function HtmlPreview({ file }: { file: PreviewFile }) {
  const state = usePreviewResource(async signal => {
    if (file.blob.size > TEXT_LIMIT) throw new Error('LIMIT');
    const decoded = decodeText(new Uint8Array(await file.blob.arrayBuffer()), file.type); signal.throwIfAborted(); return decoded.text;
  }, [file.blob, file.type]);
  return state.value !== undefined ? <SafeAttachmentHtml html={state.value} /> : <PreviewStatus loading={state.loading} error={state.error} />;
}
