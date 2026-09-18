import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import type { StoreState } from '../../store/index.ts';
import { shortcutBus } from '../../utils/shortcutBus.ts';
import { desktopTitlebarHeight, isElectronShell, isMacDesktopShell, syncDesktopTitlebarTheme } from '../../utils/desktopShell.ts';
import { navigateAppHistory, useAppViewHistoryState } from './useAppViewHistory.tsx';

/**
 * Integrated title bar for the Electron shell.
 *
 * The window uses `titleBarStyle: 'hidden'` with the Window Controls Overlay, so
 * this component only draws the Inboxora part (back / forward / search /
 * settings) and leaves the native minimize / maximize / close buttons to the OS.
 * It renders nothing in the browser and in the Capacitor shell: the web build
 * must not gain desktop-only chrome.
 *
 * Back / Forward walk Inboxora's own view history (see useAppViewHistory), not
 * `webContents.navigationHistory`: the app swaps Zustand state rather than
 * loading documents, so the browser history only ever held login/OAuth pages.
 *
 * Shell detection is fixed for the page load (the Electron preload runs before
 * the bundle), so the outer component needs no hooks and can decide up front.
 */
const ELECTRON_SHELL = isElectronShell();

interface DesktopTitleBarProps {
  /**
   * 'full' — the complete bar with navigation, search and settings (main app).
   * 'drag' — a drag-only strip for screens without an app toolbar (login/lock),
   *          so a hidden-title-bar window can still be moved.
   */
  variant?: 'full' | 'drag';
}

/** Keep the native overlay colours in step with the resolved Inboxora theme. */
function useTitlebarThemeSync() {
  useEffect(() => {
    if (!ELECTRON_SHELL) return undefined;

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        syncDesktopTitlebarTheme();
      });
    };

    syncDesktopTitlebarTheme();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mailflow-theme'] });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', schedule);

    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', schedule);
    };
  }, []);
}

function titlebarLayout(): CSSProperties {
  const height = desktopTitlebarHeight();
  // The overlay reports where the native window controls live, so content never
  // slides under them (RTL or a left-hand controls layout included). On macOS the
  // traffic lights sit in the top-left, hence the extra inset.
  const paddingLeft = isMacDesktopShell()
    ? 'calc(env(titlebar-area-x, 0px) + 74px)'
    : 'calc(env(titlebar-area-x, 0px) + 10px)';
  const paddingRight = 'calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%))';

  return {
    height,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingLeft,
    paddingRight,
    boxSizing: 'border-box',
    background: 'var(--bg-primary)',
    borderBottom: '1px solid var(--border-subtle)',
  };
}

function TitlebarButton({ label, disabled = false, onClick, children }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const background = disabled ? 'transparent' : hovered ? 'var(--bg-hover)' : 'transparent';
  const color = disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)';

  return (
    <button
      type="button"
      className="desktop-titlebar__control"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, flexShrink: 0,
        background, color,
        border: 'none', borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 0.12s, color 0.12s',
      }}
    >
      {children}
    </button>
  );
}

/** Drag-only strip: no app toolbar exists yet, but the window must be movable. */
function DesktopDragStrip() {
  useTitlebarThemeSync();
  return (
    <div
      data-testid="desktop-titlebar-drag"
      className="desktop-titlebar"
      style={{ ...titlebarLayout(), position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9000 }}
    />
  );
}

function DesktopTitleBarContent() {
  const { t } = useTranslation();
  const navigation = useAppViewHistoryState();
  const searchQuery = useStore((state: StoreState) => state.searchQuery);
  const setSearchQuery = useStore((state: StoreState) => state.setSearchQuery);
  const setShowAdmin = useStore((state: StoreState) => state.setShowAdmin);
  const setAdminTab = useStore((state: StoreState) => state.setAdminTab);
  const setShowContacts = useStore((state: StoreState) => state.setShowContacts);
  const setShowCalendar = useStore((state: StoreState) => state.setShowCalendar);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useTitlebarThemeSync();

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  // The message list owns the '/' shortcut; Ctrl/Cmd+E is the desktop titlebar
  // equivalent and must not steal Ctrl+K from the command palette.
  useEffect(() => {
    shortcutBus.on('focusSearch', focusSearch);
    // Cmd+E on macOS, Ctrl+E elsewhere.
    const onKeyDown = (event: KeyboardEvent) => {
      const primaryModifier = isMacDesktopShell() ? event.metaKey : event.ctrlKey;
      if (primaryModifier && !event.altKey && !event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      shortcutBus.off('focusSearch', focusSearch);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [focusSearch]);

  const switchToMail = () => {
    setShowContacts(false);
    setShowCalendar(false);
  };

  return (
    <div data-testid="desktop-titlebar" className="desktop-titlebar" style={titlebarLayout()}>
      <TitlebarButton label={t('common.back')} disabled={!navigation.canGoBack} onClick={() => navigateAppHistory('back')}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </TitlebarButton>
      <TitlebarButton label={t('desktop.titlebar.forward')} disabled={!navigation.canGoForward} onClick={() => navigateAppHistory('forward')}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </TitlebarButton>

      <div className="desktop-titlebar__control" style={{ position: 'relative', flex: '0 1 460px', minWidth: 120, margin: '0 4px' }}>
        <span style={{
          position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-tertiary)', pointerEvents: 'none', display: 'flex',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          aria-label={t('desktop.titlebar.search')}
          placeholder={t('desktop.titlebar.search')}
          onChange={(event) => { setSearchQuery(event.target.value); switchToMail(); }}
          onFocus={switchToMail}
          style={{
            width: '100%', height: 30, boxSizing: 'border-box',
            padding: searchQuery ? '0 28px 0 32px' : '0 10px 0 32px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none',
          }}
        />
        {searchQuery && (
          <button
            type="button"
            className="desktop-titlebar__control"
            aria-label={t('messageList.clearSearch')}
            title={t('messageList.clearSearch')}
            onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: 'var(--text-tertiary)',
              cursor: 'pointer', padding: 2, display: 'flex',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <TitlebarButton
        label={t('sidebar.settings')}
        onClick={() => { setAdminTab('notifications'); setShowAdmin(true); }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </TitlebarButton>
    </div>
  );
}

export default function DesktopTitleBar({ variant = 'full' }: DesktopTitleBarProps) {
  if (!ELECTRON_SHELL) return null;
  return variant === 'drag' ? <DesktopDragStrip /> : <DesktopTitleBarContent />;
}
