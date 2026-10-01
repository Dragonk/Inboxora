import { useTranslation } from 'react-i18next';
import type { AttachmentWindow as WindowDescriptor } from '../../utils/attachments/types.ts';
import { useStore } from '../../store/index.ts';
import FloatingWindow from '../FloatingWindow.tsx';
import AttachmentPreviewSurface from './AttachmentPreviewSurface.tsx';
import './attachments.css';
export default function AttachmentWindow({ window: win, zIndex }: { window: WindowDescriptor; zIndex: number }) {
  const { t } = useTranslation(); const close = useStore(state => state.closeAttachmentWindow); const focus = useStore(state => state.focusAttachmentWindow);
  const minimize = useStore(state => state.minimizeAttachmentWindow); const update = useStore(state => state.updateAttachmentWindowRect);
  const select = useStore(state => state.selectAttachmentWindow);
  const restore = useStore(state => state.restoreAttachmentWindow);
  const epoch = useStore(state => state.authEpoch);
  if (epoch !== win.selection.authEpoch) return null;
  return <FloatingWindow contentTitlebar title={win.selection.attachments[win.selection.index]?.filename} rect={win} zIndex={zIndex}
    onClose={() => close(win.id)} onFocus={() => focus(win.id)} onMinimize={() => minimize(win.id, true)} onCommitRect={rect => update(win.id, rect)}
    closeLabel={t('common.close')} minimizeLabel={t('window.minimize')}>
    <AttachmentPreviewSurface onFullscreen={() => restore(win.id)} onMinimize={() => minimize(win.id, true)} selection={win.selection} onSelect={index => select(win.id, index)} onClose={() => close(win.id)} />
  </FloatingWindow>;
}
