import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import FloatingWindow from './FloatingWindow.tsx';
import MessagePane from './MessagePane.tsx';
import type { StoreState } from '../store/index.ts';

type StoreMessageWindow = StoreState['messageWindows'][number];

interface FloatingWindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MessageWindowProps {
  win: StoreMessageWindow;
  zIndex: number;
}

type CompleteMessageWindow = StoreMessageWindow & FloatingWindowRect & {
  winId: string;
  messageId: string;
};

function hasCompleteWindowDetails(window: StoreMessageWindow): window is CompleteMessageWindow {
  return typeof window.winId === 'string'
    && typeof window.messageId === 'string'
    && Number.isFinite(window.x)
    && Number.isFinite(window.y)
    && Number.isFinite(window.w)
    && Number.isFinite(window.h);
}

// One detached message window (#219): a FloatingWindow frame wrapping a MessagePane
// instance bound to a specific message id (independent of the main list selection).
export default function MessageWindow({ win, zIndex }: MessageWindowProps) {
  const { t } = useTranslation();
  const closeMessageWindow = useStore((s: StoreState) => s.closeMessageWindow);
  const focusMessageWindow = useStore((s: StoreState) => s.focusMessageWindow);
  const setMessageWindowMinimized = useStore((s: StoreState) => s.setMessageWindowMinimized);
  const updateMessageWindowRect = useStore((s: StoreState) => s.updateMessageWindowRect);

  // Resolve the title + accent from whatever copy of the message the store has.
  const message = useStore((s: StoreState) =>
    (s.searchQuery.trim() ? s.searchResults : s.messages).find(m => m.id === win.messageId)
    ?? Object.values(s.threadMessages).flat().find(m => m.id === win.messageId));
  const accentColor = message && typeof message.account_color === 'string'
    ? message.account_color
    : undefined;
  const subject = message && typeof message.subject === 'string' ? message.subject.trim() : '';
  const title = subject || t('common.noSubject');

  const onClose = useCallback(() => {
    if (typeof win.winId === 'string') closeMessageWindow(win.winId);
  }, [closeMessageWindow, win.winId]);
  const onFocus = useCallback(() => {
    if (typeof win.winId === 'string') focusMessageWindow(win.winId);
  }, [focusMessageWindow, win.winId]);
  const onMinimize = useCallback(() => {
    if (typeof win.winId === 'string') setMessageWindowMinimized(win.winId, true);
  }, [setMessageWindowMinimized, win.winId]);
  const onCommitRect = useCallback((rect: FloatingWindowRect) => {
    if (typeof win.winId === 'string') updateMessageWindowRect(win.winId, rect);
  }, [updateMessageWindowRect, win.winId]);

  if (!hasCompleteWindowDetails(win)) return null;

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
