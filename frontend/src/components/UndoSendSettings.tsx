import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import SegmentedChoices from './SegmentedChoices.tsx';

/** Edit the server-backed delay while preserving preference-loading and session guards. */
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
    <div id={id} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('undoSendSetting.title')}</div>
    <p id={`${id}-help`} style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 12px' }}>{t('undoSendSetting.description')}</p>
    {![0, 15, 30, 60].includes(seconds) && status === 'ready' &&
      <p role="status">{t('undoSendSetting.legacyValue', { count: seconds })}</p>}
    <SegmentedChoices label={t('undoSendSetting.title')} value={seconds} disabled={saving || status !== 'ready'}
      choices={[0, 15, 30, 60].map(value => ({ value, label: value === 0 ? '0 s' : `${value} s` }))}
      onChange={value => void save(value)} />
    {status === 'loading' && <p role="status">{t('undoSendSetting.loading')}</p>}
    {error && <p role="alert">{t('undoSendSetting.saveError')}</p>}
    {status === 'error' && <p role="alert">{t('undoSendSetting.loadError')} <button type="button" onClick={() => void useStore.getState().loadPreferences()}>{t('undoSendSetting.retry')}</button></p>}
  </section>;
}
