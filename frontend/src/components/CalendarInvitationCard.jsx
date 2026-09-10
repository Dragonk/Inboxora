import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { Button } from './ui.jsx';
import { intlLocale } from '../utils/intlLocale.js';

export default function CalendarInvitationCard({ messageId }) {
  const { t, i18n } = useTranslation();
  const [invitation, setInvitation] = useState(null);
  const [calendars, setCalendars] = useState([]);
  const [calendarId, setCalendarId] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setInvitation(null); setError(false); setSaved(false);
    Promise.all([api.calendar.getInvitation(messageId), api.calendar.listCalendars()]).then(([result, list]) => {
      if (cancelled) return;
      const writable = (list.calendars || []).filter(calendar => !calendar.read_only && calendar.source === 'local');
      setInvitation(result.invitation); setCalendars(writable); setCalendarId(writable[0]?.id || '');
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [messageId, retry]);
  const add = async () => {
    if (saving) return;
    setSaving(true); setError(false);
    try { await api.calendar.addInvitation(messageId, calendarId); setSaved(true); window.dispatchEvent(new Event('inboxora:calendar-changed')); }
    catch { setError(true); }
    finally { setSaving(false); }
  };
  return <section data-testid="calendar-invitation-card" style={{ padding: 14, marginBottom: 14, border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
    <strong>{t('calendar.mailInvitation')}</strong>
    {invitation && <><p>{invitation.summary || t('calendar.untitled')}</p>
      {invitation.startsAt && <p>{invitation.allDay ? String(invitation.startsAt).slice(0, 10) : new Date(invitation.startsAt).toLocaleString(intlLocale(i18n.language))}</p>}
      {invitation.location && <p>{invitation.location}</p>}
      {invitation.description && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{invitation.description}</p>}
      {invitation.method === 'CANCEL' ? <p role="status">{t('calendar.invitationCancelled')}</p> : saved ? <p role="status">{t('calendar.invitationAdded')}</p> : <div className="ui-form">
        <label>{t('calendar.calendar')}<select value={calendarId} onChange={event => setCalendarId(event.target.value)} disabled={saving}>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
        {!calendars.length && <p>{t('calendar.noWritable')}</p>}
        <Button variant="primary" onClick={add} disabled={!calendarId || saving}>{t(saving ? 'calendar.saving' : 'calendar.addInvitation')}</Button>
        <small>{t('calendar.invitationLocalCopy')}</small>
      </div>}
    </>}
    {error && <p role="alert">{t('calendar.invitationLoadFailed')} <Button onClick={() => invitation ? add() : setRetry(value => value + 1)} disabled={saving}>{t('common.retry')}</Button></p>}
  </section>;
}
