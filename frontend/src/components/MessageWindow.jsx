import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import FloatingWindow from './FloatingWindow.jsx';
import MessagePane from './MessagePane.jsx';

// One detached message window (#219): a FloatingWindow frame wrapping a MessagePane
// instance bound to a specific message id (independent of the main list selection).
export default function MessageWindow({ win, zIndex }) {
  const { t } = useTranslation();
  const closeMessageWindow = useStore(s => s.closeMessageWindow);
  const focusMessageWindow = useStore(s => s.focusMessageWindow);
  const setMessageWindowMinimized = useStore(s => s.setMessageWindowMinimized);
  const updateMessageWindowRect = useStore(s => s.updateMessageWindowRect);

  // Resolve the title + accent from whatever copy of the message the store has.
  const message = useStore(s =>
    (s.searchQuery.trim() ? s.searchResults : s.messages).find(m => m.id === win.messageId)
    ?? Object.values(s.threadMessages).flat().find(m => m.id === win.messageId));
  const accentColor = message?.account_color || undefined;
  const title = message?.subject?.trim() || t('common.noSubject');

  const onClose = useCallback(() => closeMessageWindow(win.winId), [closeMessageWindow, win.winId]);
  const onFocus = useCallback(() => focusMessageWindow(win.winId), [focusMessageWindow, win.winId]);
  const onMinimize = useCallback(() => setMessageWindowMinimized(win.winId, true), [setMessageWindowMinimized, win.winId]);
  const onCommitRect = useCallback((rect) => updateMessageWindowRect(win.winId, rect), [updateMessageWindowRect, win.winId]);

  return (
    <FloatingWindow
      rect={{ x: win.x, y: win.y, w: win.w, h: win.h }}
      zIndex={zIndex}
      title={title}
      accentColor={accentColor}
      onFocus={onFocus}
      onCommitRect={onCommitRect}
      onMinimize={onMinimize}
      onClose={onClose}
      minimizeLabel={t('window.minimize')}
      closeLabel={t('window.close')}
    >
      <MessagePane windowMessageId={win.messageId} onWindowClose={onClose} />
    </FloatingWindow>
  );
}
