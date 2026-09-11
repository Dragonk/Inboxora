import { agendaDays, sortedDayEvents } from './calendarView.js';
import { EmptyState } from './ui.jsx';

function AgendaEntries({ events, locale, onOpen, t }) {
  return events.map(event => <button key={event.id} type="button" className="calendar-agenda-entry" onClick={() => onOpen(event)}>
    <span className="calendar-agenda-color" style={{ background: event.calendar_color || 'var(--accent)' }} />
    <span className="calendar-agenda-time">{event.all_day || event.allDay ? t('calendar.allDay') : <>{new Date(event.starts_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}<br />{new Date(event.ends_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</>}</span>
    <span className="calendar-agenda-text"><strong>{event.summary || t('calendar.untitled')}</strong>{event.location && <small>{event.location}</small>}{event.read_only && <small>{t('calendar.readOnly')}</small>}</span>
  </button>);
}

export default function CalendarAgenda({ events, anchor, locale, onOpen, t, monthly = false }) {
  if (monthly) {
    const groups = agendaDays(events, anchor);
    return <div data-testid="calendar-agenda-view" className="calendar-month-agenda">
      {groups.length ? groups.map(({ day, events: entries }) => <section key={day.toISOString()}>
        <h3>{day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        <AgendaEntries events={entries} locale={locale} onOpen={onOpen} t={t} />
      </section>) : <EmptyState title={t('calendar.emptyMonth')} />}
    </div>;
  }
  const entries = sortedDayEvents(events, anchor);
  return <div data-testid="calendar-day-agenda">
    <h2>{anchor.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    <p className="calendar-agenda-count">{t('calendar.eventCount', { count: entries.length })}</p>
    {entries.length ? <AgendaEntries events={entries} locale={locale} onOpen={onOpen} t={t} /> : <EmptyState title={t('calendar.emptyDay')} />}
  </div>;
}
