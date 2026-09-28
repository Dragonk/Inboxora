import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';

export default function UndoSendSettings() {
  const { t } = useTranslation();
  const id = useId();
  const seconds = useStore(s => s.undoSendSeconds);
  const status = useStore(s => s.undoSendPreferencesStatus);
  const saving = useStore(s => s.undoSendSecondsSaving);
  const epoch = useStore(s => s.authEpoch);
  const [error, setError] = useState(false);
  const operation = useRef(0);
  useEffect(() => {
    setError(false);
    return () => { operation.current += 1; };
  }, [epoch]);

  const save = async (value: number) => {
    const currentOperation = ++operation.current;
    setError(false);
    try { await useStore.getState().setUndoSendSeconds(value); }
    catch {
      if (operation.current === currentOperation && useStore.getState().authEpoch === epoch) setError(true);
    }
  };

  return <section style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
    <label htmlFor={id} style={{ display: 'block', fontWeight: 600 }}>{t('undoSendSetting.title')}</label>
    <p id={`${id}-help`} style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('undoSendSetting.description')}</p>
    <select id={id} aria-describedby={`${id}-help`} value={seconds} disabled={saving || status === 'loading'} onChange={event => void save(Number(event.target.value))}>
      {Array.from({ length: 61 }, (_, value) => <option key={value} value={value}>{value === 0 ? t('undoSendSetting.off') : t('undoSendSetting.seconds', { count: value })}</option>)}
    </select>
    {status === 'loading' && <p role="status">{t('undoSendSetting.loading')}</p>}
    {error && <p role="alert">{t('undoSendSetting.saveError')}</p>}
    {status === 'error' && <p role="alert">{t('undoSendSetting.loadError')} <button type="button" onClick={() => void useStore.getState().loadPreferences()}>{t('undoSendSetting.retry')}</button></p>}
  </section>;
}
