import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { Button, inputStyle } from './ui.tsx';
export default function AttachmentDisplaySettings() {
  const { t } = useTranslation(); const id = useId();
  const saved = useStore(state => state.attachmentWarningMiB); const epoch = useStore(state => state.authEpoch);
  const [value, setValue] = useState(String(saved)); const [saving, setSaving] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { setValue(String(saved)); setSaving(false); setFailed(false); }, [saved, epoch]);
  const number = Number(value); const valid = value !== '' && Number.isInteger(number) && number >= 0 && number <= 150;
  const save = async () => {
    if (!valid || saving) return; setSaving(true); setFailed(false);
    try { await useStore.getState().setAttachmentWarningMiB(number); }
    catch { if (useStore.getState().authEpoch === epoch) setFailed(true); }
    finally { if (useStore.getState().authEpoch === epoch) setSaving(false); }
  };
  return <section className="account-ui-section">
    <h3>{t('attachment.settings.title')}</h3><p id={`${id}-help`}>{t('attachment.settings.description')}</p>
    <label htmlFor={id}>{t('attachment.settings.threshold')}</label>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <input id={id} type="number" min={0} max={150} step={1} style={{ ...inputStyle, width: 110 }} value={value} onChange={event => setValue(event.target.value)} aria-describedby={`${id}-help`} disabled={saving} />
      <Button disabled={!valid || saving || number === saved} onClick={() => void save()}>{t('common.save')}</Button>
      <Button disabled={saving || number === saved} onClick={() => setValue(String(saved))}>{t('common.cancel')}</Button>
    </div>{failed && <p role="alert">{t('attachment.settings.saveError')}</p>}
  </section>;
}
