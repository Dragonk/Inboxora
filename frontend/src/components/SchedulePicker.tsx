import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveScheduleTime, schedulePreview, scheduleWallTime } from '../utils/scheduleTime.ts';
import type { ScheduleSelection } from '../utils/scheduledMail.ts';

export default function SchedulePicker({ onConfirm, onCancel, initialTimeZone, initialScheduledAt, busy = false }: {
  onConfirm: (selection: ScheduleSelection) => void; onCancel: () => void;
  initialTimeZone?: string; initialScheduledAt?: string; busy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [timeZone, setTimeZone] = useState(initialTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [wall, setWall] = useState(() => scheduleWallTime(initialScheduledAt || new Date(Date.now() + 3600000).toISOString(), timeZone));
  const result = resolveScheduleTime(wall, timeZone);
  return <div role="dialog" aria-modal="true" aria-label={t('queue.scheduleSend')} style={{ position: 'fixed', inset: 0, zIndex: 12000, background: '#0008', display: 'grid', placeItems: 'center', padding: 16 }}>
    <form onSubmit={event => { event.preventDefault(); const current = resolveScheduleTime(wall, timeZone); if (current.instant) onConfirm({ scheduledAt: current.instant, timeZone }); }} style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', borderRadius: 12, padding: 24, width: 'min(460px, 100%)', display: 'grid', gap: 16 }}>
      <h2>{t('queue.scheduleSend')}</h2>
      <label>{t('queue.dateTime')}<input data-testid="schedule-date-time" type="datetime-local" value={wall} onChange={event => setWall(event.target.value)} required disabled={busy} style={{ display: 'block', width: '100%' }} /></label>
      <label>{t('queue.timeZone')}<input data-testid="schedule-zone" value={timeZone} onChange={event => setTimeZone(event.target.value)} required disabled={busy} style={{ display: 'block', width: '100%' }} /></label>
      {result.error ? <p role="alert">{({ invalidTime: t('queue.invalidTime'), ambiguousTime: t('queue.ambiguousTime'), pastTime: t('queue.pastTime') })[result.error]}</p> : <p role="status">{schedulePreview(result.instant, timeZone, i18n.language)}</p>}
      <div style={{ display: 'flex', gap: 12 }}><button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button><button data-testid="schedule-confirm" type="submit" disabled={busy || !!result.error}>{t('queue.saveSchedule')}</button></div>
    </form>
  </div>;
}
