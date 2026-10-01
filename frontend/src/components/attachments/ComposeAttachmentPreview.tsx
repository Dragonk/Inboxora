import { useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { draftPreviewBlob, type DraftPreviewSource } from '../../utils/attachments/draftPreview.ts';
import AttachmentPreviewSurface from './AttachmentPreviewSurface.tsx';
import { Dialog } from '../ui.tsx';
import './attachments.css';

/** This lifetime belongs to the composer, never the persisted attachment store. */
export default function ComposeAttachmentPreview({ files, initialIndex, epoch, onClose }: {
  files: DraftPreviewSource[]; initialIndex: number; epoch: number; onClose: () => void;
}) {
  const { t } = useTranslation(); const currentEpoch = useStore(state => state.authEpoch);
  const escape = useRef(onClose);
  const [index, setIndex] = useState(initialIndex);
  const attachments = useMemo(() => files.map((file, i) => ({ filename: file.filename, type: file.type, size: file.size, path: file.path || `compose:${i}` })), [files]);
  const localFiles = useMemo(() => new Map(files.flatMap((file, i) => typeof file.content === 'string'
    ? [[`compose:${i}`, async () => draftPreviewBlob(file.content!, file.type)] as const] : [])), [files]);
  if (currentEpoch !== epoch) return null;
  return <Dialog title={t('attachment.preview.title')} closeLabel={t('common.close')} onClose={onClose} onEscape={() => escape.current()} hideHeader unscaled
    overlayClassName="attachment-preview-overlay" className="attachment-preview-dialog" testId="attachment-preview-dialog">
    <AttachmentPreviewSurface selection={{ attachments, index, authEpoch: epoch }} localFiles={localFiles} escapeRef={escape} onSelect={setIndex} onClose={onClose} />
  </Dialog>;
}
