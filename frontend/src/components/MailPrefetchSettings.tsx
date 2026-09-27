import { parsePrefetchInput } from '../utils/mailPrefetch.ts';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { api } from '../utils/api.ts';
import { Button, inputStyle } from './ui.tsx';

interface PrefetchSettingsResponse {
  settings: Record<string, string>;
  mailPrefetch?: { disabledByEnvironment?: boolean };
}

function PrefetchEditor({ userId, epoch }: { userId: string; epoch: number }) {
  const { t } = useTranslation();
  const id = useId();
  const alive = useRef(false);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('25');
  const [savedValue, setSavedValue] = useState('25');
  const [environmentOff, setEnvironmentOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const requestSerial = useRef(0);
  const isCurrent = () => {
    const state = useStore.getState();
    return alive.current && state.authEpoch === epoch && state.user?.id === userId && state.user.isAdmin === true;
  };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setLoaded(false); setLoadFailed(false);
    void api.admin.getSettings().then((response: PrefetchSettingsResponse) => {
      const state = useStore.getState();
      if (cancelled || state.authEpoch !== epoch || state.user?.id !== userId || !state.user.isAdmin) return;
      const raw = response.settings.mail_body_prefetch_limit ?? '25';
      if (parsePrefetchInput(raw) === null) throw new Error('Invalid prefetch settings response');
      setValue(raw); setSavedValue(raw);
      setEnvironmentOff(response.mailPrefetch?.disabledByEnvironment === true);
      setLoaded(true);
    }).catch(() => {
      const state = useStore.getState();
      if (!cancelled && state.authEpoch === epoch && state.user?.id === userId && state.user.isAdmin) setLoadFailed(true);
    });
    return () => { cancelled = true; alive.current = false; };
  }, [userId, epoch, reload]);

  const parsed = parsePrefetchInput(value);
  const save = async () => {
    if (!isCurrent() || !loaded || parsed === null || busy) return;
    const serial = ++requestSerial.current;
    const submitted = String(parsed);
    setBusy(true); setSaved(false); setSaveFailed(false);
    try {
      await api.admin.updateSettings({ mail_body_prefetch_limit: parsed });
      if (!isCurrent() || serial !== requestSerial.current) return;
      setSavedValue(submitted); setSaved(true);
    } catch {
      if (isCurrent() && serial === requestSerial.current) setSaveFailed(true);
    } finally {
      if (isCurrent() && serial === requestSerial.current) setBusy(false);
    }
  };
  return <section data-testid="mail-prefetch-settings" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.prefetch.title')}</h2>
    <p className="settings-choice-description">{t('admin.prefetch.description')}</p>
    {loadFailed ? <div role="alert">
      <p>{t('admin.prefetch.loadError')}</p>
      <Button onClick={() => setReload(n => n + 1)}>{t('common.retry')}</Button>
    </div> : !loaded ? <p role="status">{t('common.loading')}</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={id} className="settings-choice-label">{t('admin.prefetch.limitLabel')}</label>
      <div style={{ marginTop: 8, marginBottom: 12 }}>
        <input id={id} data-testid="mail-prefetch-limit" type="number" inputMode="numeric" min={0} max={100} step={1}
          value={value} disabled={busy} aria-invalid={parsed === null} aria-describedby={`${id}-hint ${id}-policy`}
          onChange={event => { setValue(event.target.value); setSaved(false); setSaveFailed(false); }}
          style={{ ...inputStyle, width: 120, maxWidth: '100%' }} />
      </div>
      <p id={`${id}-hint`} className="settings-choice-description">{t('admin.prefetch.hint')}</p>
      <p id={`${id}-policy`} className="settings-choice-description">{t('admin.prefetch.policy')}</p>
      {environmentOff && <p role="status" data-testid="mail-prefetch-environment-off" style={{ color: 'var(--text-secondary)' }}>{t('admin.prefetch.environmentOff')}</p>}
      {parsed === null && <p role="alert" style={{ color: 'var(--red)' }}>{t('admin.prefetch.invalid')}</p>}
      {saveFailed && <p role="alert" style={{ color: 'var(--red)' }}>{t('admin.prefetch.saveError')}</p>}
      <Button type="submit" disabled={busy || parsed === null || value === savedValue}>{busy ? t('common.saving') : t('common.save')}</Button>
      {saved && <p role="status" data-testid="mail-prefetch-saved">{t('admin.prefetch.saved')}</p>}
    </form>}
  </section>;
}

/** Keying by authentication epoch remounts the editor when the session changes;
 * late responses from an old admin never populate a later user's settings. */
export default function MailPrefetchSettings() {
  const user = useStore(state => state.user);
  const epoch = useStore(state => state.authEpoch);
  if (!user?.isAdmin || !user.id) return null;
  return <PrefetchEditor key={`${epoch}:${user.id}`} userId={user.id} epoch={epoch} />;
}
