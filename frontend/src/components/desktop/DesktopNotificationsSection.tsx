import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Desktop-only notification settings.
 *
 * Electron shows native OS notifications driven by the Inboxora WebSocket, so the
 * preference is stored locally by the Electron main process (never synced as an
 * account setting) and never depends on Web Push / VAPID. It replaces the Web
 * Push section in Settings when running inside the desktop shell.
 */
type TestOutcome = 'sent' | 'blocked' | 'failed';

const mutedStyle = { fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 420, lineHeight: 1.5 } as const;

export default function DesktopNotificationsSection() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [supported, setSupported] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const notifications = typeof window === 'undefined' ? undefined : window.inboxoraNative?.notifications;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      notifications?.getSettings?.().catch(() => undefined),
      notifications?.isSupported?.().catch(() => undefined),
    ]).then(([settings, isSupported]) => {
      if (cancelled) return;
      if (settings && typeof settings.enabled === 'boolean') setEnabled(settings.enabled);
      if (typeof isSupported === 'boolean') setSupported(isSupported);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [notifications]);

  const toggle = useCallback(async () => {
    if (busy) return;
    const next = !enabled;
    setBusy(true);
    setTestOutcome(null);
    try {
      const settings = await notifications?.setEnabled?.(next);
      setEnabled(settings && typeof settings.enabled === 'boolean' ? settings.enabled : next);
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, notifications]);

  const sendTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setTestOutcome(null);
    try {
      const result = await notifications?.showTest?.({
        title: 'Inboxora',
        body: t('desktop.notifications.testBody'),
      });
      if (result?.shown) {
        setTestOutcome('sent');
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
  }, [busy, notifications, t]);

  const statusColor = !supported || !enabled ? 'var(--text-tertiary)' : 'var(--green, #22c55e)';
  const statusLabel = !supported
    ? t('desktop.notifications.statusUnsupported')
    : enabled
      ? t('desktop.notifications.statusOn')
      : t('desktop.notifications.statusOff');

  const buttonStyle = (primary: boolean) => ({
    padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
    cursor: busy || (primary && !supported) ? 'not-allowed' : 'pointer',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'white' : 'var(--text-secondary)',
    border: primary ? '1px solid transparent' : '1px solid var(--border)',
    opacity: busy || (primary && !supported) ? 0.6 : 1,
    transition: 'all 0.15s',
  }) as const;

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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        <button
          type="button"
          style={buttonStyle(true)}
          disabled={busy || !supported || !enabled}
          onClick={sendTest}
        >
          {t('desktop.notifications.test')}
        </button>
        {testOutcome !== null && (
          <span style={{
            alignSelf: 'center', fontSize: 12,
            color: testOutcome === 'sent' ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)',
          }}>
            {testOutcome === 'sent'
              ? t('desktop.notifications.testSent')
              : testOutcome === 'blocked'
                ? t('desktop.notifications.testBlocked')
                : t('desktop.notifications.testFailed')}
          </span>
        )}
      </div>

      {testOutcome === 'failed' && (
        <div style={{
          marginTop: 16, padding: '12px 16px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
          borderLeft: '3px solid var(--amber, #f59e0b)',
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
            {t('desktop.notifications.permissionHint')}
          </div>
          <button
            type="button"
            style={buttonStyle(false)}
            disabled={busy}
            onClick={() => { notifications?.openSettings?.().catch(() => {}); }}
          >
            {t('desktop.notifications.openSystemSettings')}
          </button>
        </div>
      )}
    </div>
  );
}
