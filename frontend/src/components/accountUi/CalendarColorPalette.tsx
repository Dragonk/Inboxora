import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.ts';
import { useStore } from '../../store/index.ts';
import { Button } from '../ui.tsx';
import type { CalendarRow } from '../calendarSettingsModel.ts';
import { Icon, Notice, Popover } from './AccountUi.tsx';
import { colorValue, effectiveColor, readableText } from './model.ts';
import { previewCalendarColor } from './calendarPreview.ts';
import { openSettings } from './navigation.ts';

const COLORS = ['#35558a','#3b82f6','#6366f1','#8b5cf6','#a855f7','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4'];
export default function CalendarColorPalette({ calendar, sourceId, context, anchor, onClose }: { calendar: CalendarRow; sourceId?: string; context?: string; anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const accent = colorValue(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) ?? '#35558a';
  const original = effectiveColor(calendar.color_override, calendar.source_color ?? calendar.color, accent);
  const base = effectiveColor(null, calendar.source_color, accent);
  const [value, setValue] = useState(original); const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const alive = useRef(true); const lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; previewCalendarColor(calendar.id, null, epoch); }; }, [calendar.id, epoch]);
  useEffect(() => { const color = colorValue(value); if (color) previewCalendarColor(calendar.id, color, epoch); }, [calendar.id, value, epoch]);
  const close = () => { if (!lock.current) onClose(); };
  const save = async () => {
    if (lock.current || !colorValue(value) || useStore.getState().authEpoch !== epoch) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      await api.calendar.updateCalendarColorOverride(calendar.id, reset ? null : value);
      if (!alive.current || useStore.getState().authEpoch !== epoch) return;
      window.dispatchEvent(new Event('inboxora:calendar-changed'));
      onClose();
    } catch { if (alive.current && useStore.getState().authEpoch === epoch) setError(true); }
    finally { lock.current = false; if (alive.current && useStore.getState().authEpoch === epoch) setBusy(false); }
  };
  const name = calendar.id === 'contacts-birthdays' && !calendar.custom_name ? t('accountUi.contactDates') : calendar.name ?? t('accountUi.unnamed');
  return <Popover title={t('accountUi.eventColor')} className="au-palette" busy={busy} anchor={anchor} onClose={close} footer={<><Button data-testid="calendar-color-cancel" onClick={close} disabled={busy}>{t('common.cancel')}</Button><Button data-testid="calendar-color-save" variant="primary" disabled={busy || !colorValue(value)} onClick={() => void save()}>{t('accountUi.saveColor')}</Button></>}>
    <p data-testid="calendar-color-palette" className="au-palette-context"><strong>{name}</strong>{context && <><br/>{context}</>}</p>
    <div className="au-swatches">{COLORS.map(color => <button type="button" key={color} className="au-swatch" aria-label={t('accountUi.colorValue', { color })} aria-pressed={value.toLowerCase() === color} style={{ background: color, color: readableText(color) }} disabled={busy} onClick={() => { setValue(color); setReset(false); }}>{value.toLowerCase() === color && <Icon name="check" size={15}/>}</button>)}</div>
    <div className="au-color-inputs"><input data-testid="calendar-color-input" aria-label={t('accountUi.customColor')} type="color" disabled={busy} value={colorValue(value) ?? '#35558a'} onChange={event => { setValue(event.target.value); setReset(false); }}/><input data-testid="calendar-color-hex" aria-label={t('accountUi.hexColor')} type="text" spellCheck={false} maxLength={7} value={value} disabled={busy} aria-invalid={!colorValue(value)} onChange={event => { setValue(event.target.value); setReset(false); }} /></div>
    <div className="au-color-preview"><span className="au-preview-event" style={{ background: colorValue(value) ?? original, color: readableText(colorValue(value) ?? original) }}>{t('accountUi.previewEvent')}</span></div>
    <p className="au-note">{t('accountUi.colorIsPersonal')}</p>
    {error && <Notice danger>{t('accountUi.operationFailed')}</Notice>}
    <div className="au-palette-links"><button type="button" disabled={busy} onClick={() => { setValue(base); setReset(true); }}>{t('accountUi.resetColor')}</button><button type="button" disabled={busy} onClick={() => { close(); openSettings({ module: 'calendar', section: 'resources', sourceId, resourceId: calendar.id }); }}>{t('accountUi.resourceSettings')}</button></div>
  </Popover>;
}
