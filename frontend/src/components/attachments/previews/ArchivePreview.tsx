import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { EXPANSION_LIMIT } from '../../../utils/attachments/types.ts';
import { attachmentWork } from '../../../utils/attachments/workerClient.ts';
import { processAttachment, record } from '../../../utils/attachments/processing.ts';
import type { ArchiveIndex } from '../../../utils/attachments/zip.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
export default function ArchivePreview({ file, onOpen, server = false }: { file: PreviewFile; server?: boolean; onOpen: (file: PreviewFile) => void }) {
  const { t } = useTranslation(); const [busy, setBusy] = useState<string>(); const [error, setFailureCode] = useState<string>();
  const request = useRef(new AbortController());
  useEffect(() => { request.current = new AbortController(); return () => request.current.abort(); }, [file.blob]);
  const state = usePreviewResource(async signal => {
    if (!server) return attachmentWork('index', { blob: file.blob }, signal);
    const response = await processAttachment(file.blob, 'archive-index', { filename: file.filename }, signal);
    const data = record(await response.json());
    if (!Array.isArray(data.entries) || data.entries.length > 500 || typeof data.total !== 'number' || data.total > EXPANSION_LIMIT) throw new Error('LIMIT');
    const entries = data.entries.map(value => {
      const entry = record(value);
      if (typeof entry.name !== 'string' || typeof entry.size !== 'number' || typeof entry.directory !== 'boolean' || typeof entry.encrypted !== 'boolean') throw new Error('CORRUPT');
      return { name: entry.name, size: entry.size, directory: entry.directory, encrypted: entry.encrypted };
    });
    return { entries, total: data.total } satisfies ArchiveIndex;
  }, [file.blob, file.filename, server]);
  const open = async (name: string) => {
    if (busy) return; const operation = request.current; setBusy(name); setFailureCode(undefined);
    try {
      if (file.depth >= 3) throw new Error('LIMIT');
      const remaining = EXPANSION_LIMIT - file.budget.expanded;
      const blob = server ? await (await processAttachment(file.blob, 'archive-extract', { entry: name, filename: file.filename, remaining: String(remaining) }, operation.signal)).blob()
        : await attachmentWork('extract', { blob: file.blob, name, remaining }, operation.signal);
      if (blob.size > remaining || blob.size > 50 * 1024 * 1024) throw new Error('LIMIT');
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
