import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { processAttachment, record, textValue } from '../../../utils/attachments/processing.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
import { SafeAttachmentHtml } from './HtmlPreview.tsx';
export default function EmlPreview({ file, onDownload }: { file: PreviewFile; onDownload: (file: PreviewFile) => void }) {
  const { t } = useTranslation(); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const request = useRef(new AbortController()); useEffect(() => { request.current = new AbortController(); return () => request.current.abort(); }, []);
  const state = usePreviewResource(async signal => {
    const response = record(await (await processAttachment(file.blob, 'eml-parse', {}, signal)).json());
    return { html: textValue(response.html), text: textValue(response.text), subject: textValue(response.subject), from: textValue(response.from), date: textValue(response.date),
      attachments: Array.isArray(response.attachments) ? response.attachments.map(value => { const part = record(value); return { index: Number(part.index), filename: textValue(part.filename), type: textValue(part.type), size: Number(part.size) }; }) : [] };
  }, [file.blob]);
  const download = async (index: number, filename: string, type: string) => {
    setBusy(true); setFailed(false);
    try {
      const response = await processAttachment(file.blob, 'eml-part', { index: String(index) }, request.current.signal);
      const blob = await response.blob(); request.current.signal.throwIfAborted(); onDownload({ ...file, blob, filename, type });
    } catch { if (!request.current.signal.aborted) setFailed(true); }
    finally { if (!request.current.signal.aborted) setBusy(false); }
  };
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  const mail = state.value;
  return <section className="attachment-eml"><header><h3>{mail.subject}</h3><p>{mail.from} · {mail.date}</p></header>
    {!!mail.attachments.length && <div className="attachment-toolbar">{mail.attachments.map(part => <Button disabled={busy} key={part.index} onClick={() => void download(part.index, part.filename, part.type)}>{t('attachment.preview.downloadNamed', { filename: part.filename })}</Button>)}</div>}
    {failed && <PreviewStatus error="UNAVAILABLE" />}<SafeAttachmentHtml html={mail.html} text={mail.text} />
  </section>;
}
