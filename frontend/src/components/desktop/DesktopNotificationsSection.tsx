import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Desktop-only notification settings.
 *
 * Electron shows native OS notifications driven by the Inboxora WebSocket, so the
 * preference is stored locally by the Electron main process (never synced as an
 * account setting) and never depends on Web Push / VAPID. It replaces the Web
 * Push section in Settings when running inside the desktop shell.
 *
 * The status deliberately distinguishes three things that used to be conflated by
 * `Notification.isSupported()`:
 *   - the Inboxora switch (what this card controls),
 *   - the operating system state (unreadable on Linux/macOS, read from the
 *     registry on Windows),
 *   - what a real test notification actually did ('show' / 'failed' / no event).
 */
type TestOutcome = 'confirmed' | 'unconfirmed' | 'blocked' | 'failed';
type OsState = 'enabled' | 'disabled' | 'unknown' | 'unsupported';

interface DesktopNotificationSettings {
  enabled: boolean;
  supported: boolean;
  osState: OsState;
  canOpenSystemSettings: boolean;
}

const DEFAULTS: DesktopNotificationSettings = {
  enabled: true,
  supported: true,
  osState: 'unknown',
  canOpenSystemSettings: false,
};

const mutedStyle = { fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 420, lineHeight: 1.5 } as const;

function readSettings(value: unknown): DesktopNotificationSettings {
  const settings = (value ?? {}) as Partial<DesktopNotificationSettings>;
  const osState = settings.osState;
  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : DEFAULTS.enabled,
    supported: typeof settings.supported === 'boolean' ? settings.supported : DEFAULTS.supported,
    osState: osState === 'enabled' || osState === 'disabled' || osState === 'unsupported' ? osState : 'unknown',
    canOpenSystemSettings: settings.canOpenSystemSettings === true,
  };
}

export default function DesktopNotificationsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<DesktopNotificationSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const notifications = typeof window === 'undefined' ? undefined : window.inboxoraNative?.notifications;
  // The last OS state we showed, so a change (the user flipping the Windows switch
  // and coming back) invalidates whatever the previous test reported.
  const lastOsState = useRef<OsState | null>(null);

  const refresh = useCallback(async (options: { clearOutcome?: boolean } = {}) => {
    const value = await notifications?.getSettings?.().catch(() => undefined);
    if (!value) return;
    const next = readSettings(value);
    const osStateChanged = lastOsState.current !== null && lastOsState.current !== next.osState;
    lastOsState.current = next.osState;
    setSettings(next);
    if (options.clearOutcome || osStateChanged) setTestOutcome(null);
  }, [notifications]);

  useEffect(() => {
    let cancelled = false;
    void refresh().finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [refresh]);

  // The OS state can change while Inboxora is in the background — most obviously
  // while the user is in the system notification settings we just opened. Re-read
  // it whenever the window comes back, so the card cannot keep claiming
  // "turned off in your operating system" after it was fixed (or the reverse).
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [refresh]);

  const toggle = useCallback(async () => {
    if (busy || !settings.supported) return;
    const next = !settings.enabled;
    setBusy(true);
    setTestOutcome(null);
    try {
      const value = await notifications?.setEnabled?.(next);
      if (value) {
        const applied = readSettings(value);
        lastOsState.current = applied.osState;
        setSettings(applied);
      } else {
        setSettings({ ...settings, enabled: next });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, notifications, settings]);

  const sendTest = useCallback(async () => {
    if (busy || !settings.supported || !settings.enabled) return;
    setBusy(true);
    setTestOutcome(null);
    try {
      const result = await notifications?.showTest?.({
        title: 'Inboxora',
        body: t('desktop.notifications.testBody'),
      });
      if (result?.shown && result.confirmed) {
        setTestOutcome('confirmed');
      } else if (result?.shown) {
        // Handed to the OS, but Electron reported neither 'show' nor 'failed'.
        setTestOutcome('unconfirmed');
      } else if (result?.reason === 'disabled') {
        setTestOutcome('blocked');
      } else {
        setTestOutcome('failed');
      }
    } catch {
      setTestOutcome('failed');
    } finally {
      setBusy(false);
    }
  }, [busy, notifications, settings.enabled, settings.supported, t]);

  const openSystemSettings = useCallback(() => {
    notifications?.openSettings?.()
      .then(() => refresh())
      .catch(() => {});
  }, [notifications, refresh]);

  const { enabled, supported, osState, canOpenSystemSettings } = settings;
  // A test that the operating system actually confirmed outranks a stale reading:
  // it demonstrably delivered a notification, so the OS cannot be blocking them.
  const verified = testOutcome === 'confirmed' || osState === 'enabled';
  const blockedBySystem = osState === 'disabled' && !verified;

  const statusLabel = !supported
    ? t('desktop.notifications.statusUnsupported')
    : !enabled
      ? t('desktop.notifications.statusOff')
      : verified
        ? t('desktop.notifications.statusVerified')
        : blockedBySystem
          ? t('desktop.notifications.statusBlockedOs')
          : t('desktop.notifications.statusOn');

  const statusColor = !supported || !enabled
    ? 'var(--text-tertiary)'
    : verified
      ? 'var(--green, #22c55e)'
      : blockedBySystem
        ? 'var(--amber, #f59e0b)'
        : 'var(--accent)';

  const testMessage = testOutcome === 'confirmed'
    ? t('desktop.notifications.testSent')
    : testOutcome === 'unconfirmed'
      ? t('desktop.notifications.testSentUnconfirmed')
      : testOutcome === 'blocked'
        ? t('desktop.notifications.testBlocked')
        : testOutcome === 'failed'
          ? t('desktop.notifications.testFailed')
          : null;

  const testMessageColor = testOutcome === 'confirmed'
    ? 'var(--green, #22c55e)'
    : testOutcome === 'unconfirmed'
      ? 'var(--text-tertiary)'
      : 'var(--red, #ef4444)';

  const buttonStyle = (primary: boolean) => ({
    padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
    cursor: busy ? 'not-allowed' : 'pointer',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'white' : 'var(--text-secondary)',
    border: primary ? '1px solid transparent' : '1px solid var(--border)',
    opacity: busy ? 0.6 : 1,
    transition: 'all 0.15s',
  }) as const;

  const showWarning = blockedBySystem || testOutcome === 'failed';

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 24 }} />

      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('desktop.notifications.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('desktop.notifications.description')}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        padding: '14px 16px', borderRadius: 10,
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 3 }}>
            {t('desktop.notifications.enable')}
          </div>
          <div style={mutedStyle}>{t('desktop.notifications.enableDesc')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{statusLabel}</span>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('desktop.notifications.enable')}
          disabled={!loaded || busy || !supported}
          onClick={toggle}
          style={{
            display: 'flex', alignItems: 'center', flexShrink: 0,
            width: 44, height: 24, padding: 2, borderRadius: 999,
            border: '1px solid ' + (enabled && supported ? 'transparent' : 'var(--border)'),
            background: enabled && supported ? 'var(--accent)' : 'var(--bg-tertiary)',
            cursor: !loaded || busy || !supported ? 'not-allowed' : 'pointer',
            opacity: !loaded || busy || !supported ? 0.6 : 1,
            transition: 'background 0.15s',
          }}
        >
          <span style={{
            width: 18, height: 18, borderRadius: '50%', background: 'white',
            transform: enabled && supported ? 'translateX(20px)' : 'translateX(0)',
            transition: 'transform 0.15s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
          }} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 16 }}>
        <button
          type="button"
          style={buttonStyle(true)}
          disabled={busy || !supported || !enabled}
          onClick={sendTest}
        >
          {t('desktop.notifications.test')}
        </button>
        {testMessage && testOutcome !== 'failed' && (
          <span style={{ alignSelf: 'center', fontSize: 12, color: testMessageColor }}>{testMessage}</span>
        )}
      </div>

      {showWarning && (
        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
          borderLeft: '3px solid var(--amber, #f59e0b)',
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
            {testMessage && testOutcome === 'failed' ? `${testMessage} ` : ''}
            {t('desktop.notifications.permissionHint')}
          </div>
          {canOpenSystemSettings && (
            <button type="button" style={buttonStyle(false)} disabled={busy} onClick={openSystemSettings}>
              {t('desktop.notifications.openSystemSettings')}
            </button>
          )}
        </div>
      )}

      {/* Keep the shortcut reachable even when nothing looks wrong yet: the state
          of a blocked OS is not always readable (Linux/macOS). */}
      {!showWarning && canOpenSystemSettings && (
        <div style={{ marginTop: 12 }}>
          <button type="button" style={buttonStyle(false)} disabled={busy} onClick={openSystemSettings}>
            {t('desktop.notifications.openSystemSettings')}
          </button>
        </div>
      )}
    </div>
  );
}
