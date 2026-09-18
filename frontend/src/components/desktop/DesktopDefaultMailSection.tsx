import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Desktop-only "default email app" settings.
 *
 * On Windows the app registers itself as a `mailto:` handler and as a mail client
 * (the Capabilities key that makes it appear under Settings → Default apps →
 * Email). Windows 10/11 refuse to let an application make itself the default, so
 * this card can only report the state, (re-)assert the registration and send the
 * user to the right Settings page — and it says so, instead of pretending the
 * button makes Inboxora the default on its own.
 */
type MailtoState = 'default' | 'registered' | 'not-registered' | 'unsupported';

interface MailtoSettings {
  supported: boolean;
  state: MailtoState;
  canOpenSettings: boolean;
  requiresUserConfirmation: boolean;
}

const DEFAULTS: MailtoSettings = {
  supported: false,
  state: 'unsupported',
  canOpenSettings: false,
  requiresUserConfirmation: false,
};

const mutedStyle = { fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 440, lineHeight: 1.5 } as const;

function readSettings(value: unknown): MailtoSettings {
  const settings = (value ?? {}) as Partial<MailtoSettings>;
  const state = settings.state;
  return {
    supported: settings.supported === true,
    state: state === 'default' || state === 'registered' || state === 'not-registered' ? state : 'unsupported',
    canOpenSettings: settings.canOpenSettings === true,
    requiresUserConfirmation: settings.requiresUserConfirmation === true,
  };
}

export default function DesktopDefaultMailSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MailtoSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mailto = typeof window === 'undefined' ? undefined : window.inboxoraNative?.mailto;
  // focus and visibilitychange can both fire; only the newest read may win, and a
  // failed read must not be presented as "not supported by this platform".
  const refreshToken = useRef(0);

  const refresh = useCallback(async () => {
    const token = ++refreshToken.current;
    let value: unknown;
    try {
      value = await mailto?.getSettings?.();
    } catch {
      value = undefined;
    }
    if (token !== refreshToken.current) return;
    if (!value) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setSettings(readSettings(value));
  }, [mailto]);

  useEffect(() => {
    let cancelled = false;
    void refresh().finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [refresh]);

  // The user changes this in Windows Settings, so re-read it when the window comes
  // back — otherwise the card would keep showing the state it had before.
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

  // Re-assert the registration (so Inboxora is listed) and then take the user to the
  // page where Windows actually lets them pick it.
  const setAsDefault = useCallback(async () => {
    if (busy || !settings.supported) return;
    setBusy(true);
    try {
      const value = await mailto?.register?.();
      if (value) {
        setLoadFailed(false);
        setSettings(readSettings(value));
      }
      await mailto?.openSettings?.().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [busy, mailto, settings.supported]);

  const openSystemSettings = useCallback(() => {
    mailto?.openSettings?.()
      .then(() => refresh())
      .catch(() => {});
  }, [mailto, refresh]);

  if (!loaded && !settings.supported) return null;

  const statusLabel = loadFailed
    ? t('desktop.mailto.statusUnknown')
    : settings.state === 'default'
    ? t('desktop.mailto.statusDefault')
    : settings.state === 'registered'
      ? t('desktop.mailto.statusRegistered')
      : settings.state === 'not-registered'
        ? t('desktop.mailto.statusNotRegistered')
        : t('desktop.mailto.statusUnsupported');

  const statusColor = loadFailed
    ? 'var(--text-tertiary)'
    : settings.state === 'default'
    ? 'var(--green, #22c55e)'
    : settings.state === 'registered'
      ? 'var(--amber, #f59e0b)'
      : 'var(--text-tertiary)';

  const buttonStyle = (primary: boolean) => ({
    padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
    cursor: busy || !settings.supported ? 'not-allowed' : 'pointer',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'white' : 'var(--text-secondary)',
    border: primary ? '1px solid transparent' : '1px solid var(--border)',
    opacity: busy || !settings.supported ? 0.6 : 1,
    transition: 'all 0.15s',
  }) as const;

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 24 }} />

      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('desktop.mailto.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('desktop.mailto.description')}
      </div>

      <div style={{
        padding: '14px 16px', borderRadius: 10,
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{statusLabel}</span>
        </div>

        {settings.supported && settings.requiresUserConfirmation && (
          <div style={{ ...mutedStyle, marginTop: 8 }}>{t('desktop.mailto.confirmHint')}</div>
        )}

        {loadFailed && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button type="button" style={buttonStyle(false)} disabled={busy} onClick={() => { void refresh(); }}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {!loadFailed && settings.supported && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            {settings.state !== 'default' && (
              <button type="button" style={buttonStyle(true)} disabled={busy} onClick={setAsDefault}>
                {t('desktop.mailto.setDefault')}
              </button>
            )}
            {settings.canOpenSettings && (
              <button type="button" style={buttonStyle(false)} disabled={busy} onClick={openSystemSettings}>
                {t('desktop.mailto.openSystemSettings')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
