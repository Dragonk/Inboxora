import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { useMobileInteractions } from '../../hooks/useMobileInteractions.ts';
import { Dialog } from '../ui.tsx';
import AttachmentPreviewSurface from './AttachmentPreviewSurface.tsx';
import './attachments.css';
export default function AttachmentPreviewModal() {
  const { t } = useTranslation(); const mobile = useMobileInteractions();
  const selection = useStore(state => state.attachmentPreview); const close = useStore(state => state.closeAttachmentPreview);
  const detach = useStore(state => state.detachAttachmentPreview); const windows = useStore(state => state.attachmentWindows.length);
  const select = useStore(state => state.selectAttachmentPreview);
  const escape = useRef<() => void>(close);
  if (!selection) return null;
  return <Dialog title={t('attachment.preview.title')} closeLabel={t('common.close')} onClose={close} onEscape={() => escape.current()} className="attachment-preview-dialog" testId="attachment-preview-dialog">
    <AttachmentPreviewSurface key={`${selection.authEpoch}:${selection.attachments[selection.index]?.path}`} selection={selection} onSelect={select} escapeRef={escape} onClose={close} onDetach={!mobile && windows < 4 ? detach : undefined} />
  </Dialog>;
}
