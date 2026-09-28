import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveScheduleSelection, scheduleWallTime, schedulePreview, userScheduleTimeZone } from '../utils/scheduleTime.ts';
import type { ScheduleSelection } from '../utils/scheduledMail.ts';
import { Button, Dialog } from './ui.tsx';
import './scheduledMail.css';

/** A local-time form whose saved UTC instant changes only after explicit confirmation. */
export default function SchedulePicker({ onConfirm, onCancel, initialScheduledAt, busy = false, error }: {
  onConfirm: (selection: ScheduleSelection) => void; onCancel: () => void;
  initialScheduledAt?: string; busy?: boolean; error?: string;
}) {
  const { t, i18n } = useTranslation();
  const formId = useId(); const helpId = useId();
  const [timeZone] = useState(userScheduleTimeZone);
  const [wall, setWall] = useState(() => scheduleWallTime(initialScheduledAt || new Date(Date.now() + 3600000).toISOString(), timeZone));
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const errorLabels = { invalidTime: 'queue.invalidTime', ambiguousTime: 'queue.ambiguousTime', pastTime: 'queue.pastTime' };
  const result = resolveScheduleSelection(wall, timeZone, initialScheduledAt, now);
  const [date, time = '00:00'] = wall.split('T'); const [hour, minute] = time.split(':');
  return <Dialog title={t(initialScheduledAt ? 'queue.reschedule' : 'queue.scheduleSend')} closeLabel={t('common.close')} onClose={onCancel}
    busy={busy} testId="schedule-dialog" className="scheduled-dialog" footer={<>
      <Button disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
      <Button type="submit" form={formId} variant="primary" data-testid="schedule-confirm"
        disabled={busy || !result.instant} aria-busy={busy}>{t('queue.saveSchedule')}</Button>
    </>}>
    {error && <p role="alert" className="ui-alert">{error}</p>}
    <form id={formId} className="ui-form" onSubmit={event => {
      event.preventDefault();
      const current = resolveScheduleSelection(wall, timeZone, initialScheduledAt);
      setNow(Date.now());
      if (!busy && current.instant) onConfirm({ scheduledAt: current.instant, timeZone });
    }}>
      <label>{t('message.date')}<input data-testid="schedule-date" type="date" required value={date}
        disabled={busy} aria-describedby={helpId} onChange={event => setWall(`${event.target.value}T${time}`)} /></label>
      <div className="scheduled-time-fields">
        <label>{t('queue.hour')}<select className="ui-select" data-testid="schedule-hour" value={hour} disabled={busy}
          aria-describedby={helpId} onChange={event => setWall(`${date}T${event.target.value}:${minute}`)}>
          {Array.from({ length: 24 }, (_, n) => String(n).padStart(2, '0')).map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>{t('queue.minute')}<select className="ui-select" data-testid="schedule-minute" value={minute} disabled={busy}
          aria-describedby={helpId} onChange={event => setWall(`${date}T${hour}:${event.target.value}`)}>
          {Array.from({ length: 60 }, (_, n) => String(n).padStart(2, '0')).map(value => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      <p id={helpId} className={result.error ? 'ui-alert' : 'scheduled-time-preview'} role={result.error ? 'alert' : 'status'}>
        {result.error ? t(errorLabels[result.error]) : schedulePreview(result.instant, timeZone, i18n.language)}
      </p>
    </form>
  </Dialog>;
}
