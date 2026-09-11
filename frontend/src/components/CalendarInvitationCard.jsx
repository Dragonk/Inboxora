import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { Button } from './ui.jsx';
import { formatInvitationRange } from '../utils/invitationTime.js';

// A mail invitation renders as one compact action row, in the same register as the
// unsubscribe notice: the message already shows the title above and the body below, so
// the panel only carries what the message cannot — when the event is, which calendar it
// goes into, and the one action available. Duplicating the title, location and body here
// pushed the actual message content off screen.
//
// Cancellation is actionable rather than informational: when the organizer retracts an
// invitation that was added, the copy this message created can be removed again.
export default function CalendarInvitationCard({ messageId }) {
  const { t, i18n } = useTranslation();
  const [invitation, setInvitation] = useState(null);
  const [calendars, setCalendars] = useState([]);
  const [calendarId, setCalendarId] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  // 'added' after this session added it, 'removed' after this session removed it; both
  // are also derived from the server's `localEvent` so a reload shows the same state.
  const [localEvent, setLocalEvent] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInvitation(null); setError(false); setOutcome(null); setLocalEvent(null);
    Promise.all([api.calendar.getInvitation(messageId), api.calendar.listCalendars()]).then(([result, list]) => {
      if (cancelled) return;
      const writable = (list.calendars || []).filter(calendar => !calendar.read_only && calendar.source === 'local');
      setInvitation(result.invitation);
      setLocalEvent(result.invitation?.localEvent || null);
      setCalendars(writable);
      setCalendarId(result.invitation?.localEvent?.calendarId || writable[0]?.id || '');
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [messageId, retry]);

  const added = Boolean(localEvent) && outcome !== 'removed';
  const cancelledEvent = invitation?.method === 'CANCEL';
  const when = invitation ? formatInvitationRange(invitation, i18n.language) : '';

  const notifyCalendarChanged = () => window.dispatchEvent(new Event('inboxora:calendar-changed'));

  const add = async () => {
    if (saving || !calendarId) return;
    setSaving(true); setError(false);
    try {
      await api.calendar.addInvitation(messageId, calendarId);
      setLocalEvent({ calendarId }); setOutcome('added'); notifyCalendarChanged();
    } catch { setError(true); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (saving) return;
    setSaving(true); setError(false);
    try {
      await api.calendar.removeInvitation(messageId);
      setLocalEvent(null); setOutcome('removed'); notifyCalendarChanged();
    } catch { setError(true); }
    finally { setSaving(false); }
  };

  if (error && !invitation) {
    return <div className="msg-notice" data-testid="calendar-invitation-card" role="alert" style={noticeStyle}>
      <span style={{ flex: 1 }}>{t('calendar.invitationLoadFailed')}</span>
      <Button onClick={() => setRetry(value => value + 1)} disabled={saving}>{t('common.retry')}</Button>
    </div>;
  }
  if (!invitation) return null;

  return <div className="msg-notice" data-testid="calendar-invitation-card" style={{ ...noticeStyle, borderLeftColor: 'var(--accent)' }}>
    <span style={{ minWidth: 0, flex: '1 1 200px' }}>
      <span style={{ display: 'block', fontWeight: 500, color: 'var(--text-primary)' }}>
        {cancelledEvent ? t('calendar.invitationCancelledTitle') : t('calendar.mailInvitation')}
      </span>
      {when && <span data-testid="calendar-invitation-when" style={{ display: 'block', fontSize: 11 }}>{when}</span>}
    </span>

    {cancelledEvent
      // A retracted invitation offers removal only for the copy it created; there is
      // nothing to add and nothing to reply to.
      ? (added
        ? <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span role="status">{t('calendar.invitationCancelled')}</span>
          <Button onClick={remove} disabled={saving}>{t(saving ? 'calendar.saving' : 'calendar.removeFromCalendar')}</Button>
        </span>
        : <span role="status">{t('calendar.invitationCancelledNotAdded')}</span>)
      : added
        ? <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span role="status">{t(outcome === 'added' ? 'calendar.invitationAdded' : 'calendar.invitationAlreadyAdded')}</span>
          <Button onClick={remove} disabled={saving}>{t('calendar.removeFromCalendar')}</Button>
        </span>
        : <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label={t('calendar.calendar')}
            value={calendarId}
            onChange={event => setCalendarId(event.target.value)}
            disabled={saving || !calendars.length}
          >
            {calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
          <Button variant="primary" onClick={add} disabled={!calendarId || saving}>
            {t(saving ? 'calendar.saving' : 'calendar.addInvitation')}
          </Button>
        </span>}

    {error && <span role="alert" style={{ color: 'var(--red)' }}>{t('calendar.invitationSaveFailed')}</span>}
  </div>;
}

// Matches the unsubscribe / blocked-images notice so the mail reader keeps one visual
// register for "this message needs one decision from you".
const noticeStyle = {
  marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border)', borderLeft: '3px solid var(--text-tertiary)',
  borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  fontSize: 12, color: 'var(--text-secondary)',
};
