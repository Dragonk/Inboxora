import { ArchiveSession, archiveFolder, archiveView, saveArchiveView } from '../../../utils/attachments/archiveBrowser.ts';
import ArchiveThumbnail from '../ArchiveThumbnail.tsx';
import PreviewAction from '../PreviewAction.tsx';
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
  const [view, setView] = useState(archiveView); const [folder, setFolder] = useState('');
  const [session, setSession] = useState<ArchiveSession>();
  const request = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    const reader = new ArchiveSession(file, server); setSession(reader); setFolder('');
    return () => { controller.abort(); reader.dispose(); };
  }, [file, server]);
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
      const entry = state.value?.entries.find(item => item.name === name);
      if (!entry || !session) return;
      const blob = await session.read(entry, operation.signal);
      operation.signal.throwIfAborted();
      onOpen({ filename: name, type: '', blob, budget: file.budget, depth: file.depth + 1 });
    } catch (failure) { if (!operation.signal.aborted) setFailureCode(failure instanceof Error ? failure.message : 'CORRUPT'); }
    finally { if (!operation.signal.aborted) setBusy(undefined); }
  };
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  const encrypted = state.value.entries.some(entry => entry.encrypted);
  const entries = archiveFolder(state.value.entries, folder);
  const parts = folder.split('/').filter(Boolean);
  return <section className="attachment-archive" data-view={view}>
    <div className="attachment-toolbar">
      <nav className="attachment-archive-path" aria-label={t('attachment.archive.location')}>
        <Button onClick={() => setFolder('')}>{t('attachment.archive.root')}</Button>
        {parts.map((part, i) => <Button key={i} onClick={() => setFolder(parts.slice(0, i + 1).join('/') + '/')}>{part}</Button>)}
      </nav>
      <span className="attachment-archive-view" role="group" aria-label={t('attachment.archive.view')}>
        <PreviewAction icon="outline" label={t('attachment.archive.list')} aria-pressed={view === 'list'} onClick={() => { setView('list'); saveArchiveView('list'); }} />
        <PreviewAction icon="thumbnails" label={t('attachment.archive.grid')} aria-pressed={view === 'grid'} onClick={() => { setView('grid'); saveArchiveView('grid'); }} />
      </span>
    </div>
    <p className="attachment-archive-summary">{t('attachment.preview.archiveEntries', { count: entries.length })}</p>
    {encrypted && <p role="status">{t('attachment.preview.encryptedZip')}</p>}{error && <PreviewStatus error={error} />}
    <ul>{entries.map(entry => <li key={entry.name}>
      <button type="button" className="attachment-entry-button" aria-label={entry.name} disabled={entry.encrypted || !!busy} onClick={() => entry.directory ? setFolder(entry.name.replace(/\/?$/, '/')) : void open(entry.name)}>
        {session && <ArchiveThumbnail entry={entry} session={session} enabled={view === 'grid'} />}
        <span className="attachment-entry-name">{entry.name.slice(folder.length).replace(/\/$/, '')}</span>
        <span className="attachment-entry-meta">{entry.directory ? t('attachment.archive.folder') : t('attachment.preview.bytes', { size: entry.size })}</span>
        {entry.encrypted && <span>{t('attachment.archive.locked')}</span>}
        {busy === entry.name && <span role="status">{t('common.loading')}</span>}
      </button>
    </li>)}</ul>
  </section>;
}
