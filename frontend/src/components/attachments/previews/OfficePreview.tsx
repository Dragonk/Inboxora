import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EXPANSION_LIMIT, type PreviewFile } from '../../../utils/attachments/types.ts';
import { processAttachment, record } from '../../../utils/attachments/processing.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
import AttachmentPasswordDialog from '../AttachmentPasswordDialog.tsx';
import SheetPreview from './SheetPreview.tsx';
export default function OfficePreview({ file, onOpen }: { file: PreviewFile; onOpen: (file: PreviewFile) => void }) {
  const { t } = useTranslation(); const [prompt, setPrompt] = useState(false); const [busy, setBusy] = useState(false); const [error, setFailureCode] = useState<string>();
  const request = useRef(new AbortController()); useEffect(() => { request.current = new AbortController(); return () => request.current.abort(); }, []);
  const state = usePreviewResource(async signal => record(await (await processAttachment(file.blob, 'probe', {}, signal)).json()), [file.blob]);
  const unlock = async (password: string) => {
    const operation = request.current;
    setBusy(true); setFailureCode(undefined);
    try {
      const response = await processAttachment(file.blob, 'unlock', { password }, operation.signal); password = '';
      const blob = await response.blob(); operation.signal.throwIfAborted();
      if (file.budget.expanded + blob.size > EXPANSION_LIMIT) throw new Error('LIMIT');
      file.budget.expanded += blob.size; setPrompt(false);
      onOpen({ ...file, blob });
    } catch (failure) { if (!operation.signal.aborted) setFailureCode(failure instanceof Error ? failure.message : 'CORRUPT'); }
    finally { if (!operation.signal.aborted) setBusy(false); }
  };
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  if (state.value.encrypted === false) return state.value.format === 'xls97' || state.value.format === 'xls' ? <SheetPreview file={file} /> : <PreviewStatus error="UNSUPPORTED" />;
  return <section className="attachment-status"><p>{t('attachment.preview.passwordTitle')}</p><Button onClick={() => setPrompt(true)}>{t('attachment.preview.unlock')}</Button>
    {error && error !== 'WRONG_PASSWORD' && <PreviewStatus error={error} />}
    {prompt && <AttachmentPasswordDialog server busy={busy} incorrect={error === 'WRONG_PASSWORD'} onClose={() => { request.current.abort(); request.current = new AbortController(); setPrompt(false); setBusy(false); }} onSubmit={password => void unlock(password)} />}
  </section>;
}
