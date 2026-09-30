import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { EXPANSION_LIMIT } from '../../../utils/attachments/types.ts';
import { attachmentWork } from '../../../utils/attachments/workerClient.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
export default function ArchivePreview({ file, onOpen }: { file: PreviewFile; onOpen: (file: PreviewFile) => void }) {
  const { t } = useTranslation(); const [busy, setBusy] = useState<string>(); const [error, setFailureCode] = useState<string>();
  const request = useRef(new AbortController());
  useEffect(() => { request.current = new AbortController(); return () => request.current.abort(); }, [file.blob]);
  const state = usePreviewResource(signal => attachmentWork('index', { blob: file.blob }, signal), [file.blob]);
  const open = async (name: string) => {
    if (busy) return; const operation = request.current; setBusy(name); setFailureCode(undefined);
    try {
      if (file.depth >= 3) throw new Error('LIMIT');
      const blob = await attachmentWork('extract', { blob: file.blob, name, remaining: EXPANSION_LIMIT - file.budget.expanded }, operation.signal);
      operation.signal.throwIfAborted(); file.budget.expanded += blob.size;
      onOpen({ filename: name, type: '', blob, budget: file.budget, depth: file.depth + 1 });
    } catch (failure) { if (!operation.signal.aborted) setFailureCode(failure instanceof Error ? failure.message : 'CORRUPT'); }
    finally { if (!operation.signal.aborted) setBusy(undefined); }
  };
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  const encrypted = state.value.entries.some(entry => entry.encrypted);
  return <section className="attachment-archive">
    <p>{t('attachment.preview.archiveEntries', { count: state.value.entries.length })}</p>
    {encrypted && <p role="status">{t('attachment.preview.encryptedZip')}</p>}{error && <PreviewStatus error={error} />}
    <ul>{state.value.entries.map(entry => <li key={entry.name}>
      <Button disabled={entry.directory || entry.encrypted || !!busy} onClick={() => void open(entry.name)}>{entry.name}</Button>
      <span>{t('attachment.preview.bytes', { size: entry.size })}</span>{busy === entry.name && <span role="status">{t('common.loading')}</span>}
    </li>)}</ul>
  </section>;
}
