import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { calendarVisibleRange, eventPayload, eventsForDay, layoutTimedEvents, monthRange, shiftCalendarAnchor, sortedDayEvents, toDateTimeLocal, toggleAllDayTimes, weekRange, workHoursGeometry } from './calendarView.js';
import CalendarSidebar from './CalendarSidebar.jsx';
import { createInvitationOperationController } from './calendarInvitationRetry.js';
import CalendarContextMenu from './CalendarContextMenu.jsx';
import CalendarAgenda from './CalendarAgenda.jsx';
import { Button, Dialog } from './ui.jsx';
import { useCompactLayout } from '../hooks/useCompactLayout.js';
import './calendar.css';

const DATE_LOCALE_OVERRIDES = { zhCN: 'zh-CN' };

function resolveDateLocale(language) {
  if (!language) return undefined;
  return DATE_LOCALE_OVERRIDES[language] || language.replace('_', '-');
}

const emptyForm = (calendarId = '', date = new Date()) => ({ calendarId, summary: '', description: '', location: '', url: '', organizer: '', attendees: [], sendInvites: false, inviteAccountId: '', allDay: false, startsAt: toDateTimeLocal(date), endsAt: toDateTimeLocal(new Date(date.getTime() + 3600000)) });
function iso(date) { return date.toISOString(); }
function calendarDays(anchor, weekStartsOn = 1) {
  const { start } = monthRange(anchor); const first = new Date(start); first.setDate(first.getDate() - ((first.getDay() - weekStartsOn + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => { const day = new Date(first); day.setDate(first.getDate() + i); return day; });
}
function weekDays(anchor, workWeek, weekStartsOn = 1, workDays = [1, 2, 3, 4, 5]) {
  const { start } = weekRange(anchor, weekStartsOn);
  if (!workWeek) return Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day; });
  return [...workDays].sort((a, b) => ((a - weekStartsOn + 7) % 7) - ((b - weekStartsOn + 7) % 7)).map(dayOfWeek => { const day = new Date(start); day.setDate(day.getDate() + ((dayOfWeek - weekStartsOn + 7) % 7)); return day; });
}
function isToday(day) { const today = new Date(); return day.toDateString() === today.toDateString(); }
function eventTime(event) { return new Date(event.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function isWeekend(day) { const weekday = day.getDay(); return weekday === 0 || weekday === 6; }
// "Now" marker for the time grid — read at render time (the line refreshes
// whenever the view re-renders; purely presentational, no timers).
function nowMinutes() { const now = new Date(); return now.getHours() * 60 + now.getMinutes(); }

export default function CalendarPage({ isActive = true }) {
  const { t, i18n } = useTranslation();
  const locale = resolveDateLocale(i18n.resolvedLanguage || i18n.language);
  const { showCalendar, setShowCalendar, accounts, calendarWeekStartsOn, calendarWorkDays, calendarWorkHoursStart, calendarWorkHoursEnd, visibleCalendarIds, setVisibleCalendarIds, mobileNavigationPosition } = useStore();
  const isMobile = useMobile();
  const compactViewport = useCompactLayout();
  const surfaceRef = useRef(null);
  const headerRef = useRef(null);
  const [surfaceWidth, setSurfaceWidth] = useState(Infinity);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const compact = compactViewport || surfaceWidth < 1100;
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      setSurfaceWidth(surfaceRef.current?.clientWidth || Infinity);
      setToolbarHeight(headerRef.current?.clientHeight || 0);
    });
    observer.observe(surfaceRef.current);
    observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, []);
  const [dayPanelOpen, setDayPanelOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [anchor, setAnchor] = useState(() => new Date());
  const loadGeneration = useRef(0);
  const [view, setView] = useState('month');
  const [calendars, setCalendars] = useState([]); const [events, setEvents] = useState([]);
  const [error, setError] = useState(null); const [loading, setLoading] = useState(true); const [form, setForm] = useState(null); const [saving, setSaving] = useState(false);
  const invitationOperation = useRef(null);
  if (!invitationOperation.current) invitationOperation.current = createInvitationOperationController();
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const range = useMemo(() => calendarVisibleRange(anchor, view, calendarWeekStartsOn), [anchor, calendarWeekStartsOn, view]);
  const rangeStart = iso(range.start); const rangeEnd = iso(range.end);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError(null);
    try { const [calendarResult, eventResult] = await Promise.all([api.calendar.listCalendars(), api.calendar.listEvents(rangeStart, rangeEnd)]); if (generation === loadGeneration.current) { setCalendars(calendarResult.calendars || []); setEvents(eventResult.events || []); } }
    catch (err) { if (generation === loadGeneration.current) setError(err.message || t('calendar.loadFailed')); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [rangeStart, rangeEnd, t]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isMobile || !isActive) return;
    invitationOperation.current.reset();
    setForm(null);
    setMobilePanelOpen(false);
    setDayPanelOpen(false);
    setPreview(null);
  }, [isActive, isMobile]);
  useEffect(() => {
    if (!isMobile || !showCalendar || !form) return undefined;
    const handleBack = event => { event.preventDefault(); invitationOperation.current.reset(); setForm(null); };
    window.addEventListener('inboxora:back', handleBack);
    return () => window.removeEventListener('inboxora:back', handleBack);
  }, [form, isMobile, showCalendar]);
  const writable = calendars.filter(calendar => !calendar.read_only && calendar.source === 'local');
  const senderAccounts = accounts.filter(account => account.enabled && account.smtp_host);
  const openCreate = (date = anchor) => { if (!writable.length) return; invitationOperation.current.reset(); setForm({ ...emptyForm(writable[0]?.id || '', date), mode: 'create' }); };
  const openEdit = event => { invitationOperation.current.reset(); setForm({ mode: 'edit', id: event.id, ...event, calendarId: event.calendar_id, summary: event.summary || '', description: event.description || '', location: event.location || '', url: event.url || '', organizer: event.organizer || '', attendees: Array.isArray(event.attendees) ? event.attendees : [], sendInvites: Boolean(event.invite_account_id && event.attendees?.length), inviteAccountId: event.invite_account_id || '', allDay: Boolean(event.all_day), startsAt: event.all_day ? String(event.starts_at).slice(0, 10) : toDateTimeLocal(event.starts_at), endsAt: event.all_day ? String(event.ends_at).slice(0, 10) : toDateTimeLocal(event.ends_at) }); };
  const save = async () => {
    const payload = eventPayload(form);
    if (!payload) { setError(t('calendar.invalidEvent')); return; }
    setSaving(true); setError(null);
    try {
      const { result, retryable } = await invitationOperation.current.save(form, payload, api.calendar);
      if (retryable) {
        const message = result?.invitationError || t('calendar.invitationPending', 'Invitation delivery is still pending; retry to check its status.');
        setForm(current => ({ ...current, invitationError: message }));
        setError(message);
      } else {
        setForm(null); await load();
      }
    } catch (err) {
      const message = err.message || t('calendar.saveFailed');
      if (payload.sendInvites) setForm(current => ({ ...current, invitationError: message }));
      setError(message);
    } finally { setSaving(false); }
  };
  const remove = async () => { if (!form?.id || !window.confirm(t('calendar.confirmDelete'))) return; setSaving(true); try { await api.calendar.deleteEvent(form.id, form.calendarId); invitationOperation.current.reset(); setForm(null); await load(); } catch (err) { setError(err.message || t('calendar.deleteFailed')); } finally { setSaving(false); } };
  const changeForm = (key, value) => { invitationOperation.current.reset(); setForm(current => ({ ...current, [key]: value, invitationError: null })); };
  const deleteEvent = async event => { if (!window.confirm(t('calendar.confirmDelete'))) return; try { await api.calendar.deleteEvent(event.id, event.calendar_id); invitationOperation.current.reset(); await load(); } catch (err) { setError(err.message || t('calendar.deleteFailed')); } };
  const [contextMenu, setContextMenu] = useState(null);
  const days = view === 'month' ? calendarDays(anchor, calendarWeekStartsOn) : weekDays(anchor, view === 'workweek', calendarWeekStartsOn, calendarWorkDays);
  const visibleEvents = visibleCalendarIds == null ? events : events.filter(event => visibleCalendarIds.includes(event.calendar_id));
  const toggleCalendar = id => {
    const current = visibleCalendarIds == null ? calendars.map(calendar => calendar.id) : visibleCalendarIds;
    setVisibleCalendarIds(current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };
  const title = view === 'month' || view === 'agenda'
    ? anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
    : `${days[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${days.at(-1).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const step = direction => setAnchor(current => shiftCalendarAnchor(current, view, direction));
  const shiftMiniMonth = direction => setAnchor(current => shiftCalendarAnchor(current, 'month', direction));
  const openEvent = event => {
    if (!event.read_only && event.source === 'local') openEdit(event);
    else setPreview(event);
  };
  const selectDay = day => { setAnchor(day); if (compact) setDayPanelOpen(true); };
  const sidebarProps = { anchor, calendars, visibleCalendarIds, weekStartsOn: calendarWeekStartsOn, locale,
    onSelectDate: setAnchor, onShiftMonth: shiftMiniMonth, onToggleCalendar: toggleCalendar,
    onSourcesChanged: load, onCalendarsChanged: load, onCreate: () => openCreate(), canCreate: writable.length > 0, t };
  const agendaProps = { events: visibleEvents, anchor, locale, onOpen: openEvent, t };
  return <div ref={surfaceRef} data-testid="calendar-page" className={`calendar-page calendar-v3${compact ? ' calendar-compact' : ''}${isMobile ? ' calendar-mobile' : ''}`} style={{ '--calendar-toolbar-height': `${toolbarHeight}px` }}>
    {!isMobile && <CalendarSidebar {...sidebarProps} />}
    <main className="calendar-main">
      <header ref={headerRef} className={`calendar-header${isMobile && mobileNavigationPosition === 'bottom' ? ' calendar-header-bottom' : ''}`}>
        {isMobile && <Button variant="ghost" data-testid="calendar-mobile-back" aria-label={t('calendar.back')} onClick={() => setShowCalendar(false)}>‹</Button>}
        <h1>{title}</h1>
        <div className="calendar-toolbar">
          <div role="group" className="calendar-segments" aria-label={t('calendar.view')}>
            {[['month', t('calendar.month')], ['week', t('calendar.week')], ['workweek', t('calendar.workWeek')], ['agenda', t('calendar.agenda')]].map(([value, label]) => <button type="button" key={value} data-testid={`calendar-view-${value}`} onClick={() => setView(value)} aria-pressed={view === value}>{label}</button>)}
          </div>
          <div className="calendar-date-controls">
            <Button variant="ghost" onClick={() => step(-1)} aria-label={t('calendar.previous')}>‹</Button>
            <Button variant="ghost" onClick={() => step(1)} aria-label={t('calendar.next')}>›</Button>
            <Button onClick={() => setAnchor(new Date())}>{t('calendar.today')}</Button>
            {isMobile && <Button data-testid="calendar-mobile-panel" onClick={() => setMobilePanelOpen(true)}>{t('calendar.calendars')}</Button>}
            {compact && <Button data-testid="calendar-open-day" onClick={() => setDayPanelOpen(true)}>{t('calendar.dayAgenda')}</Button>}
          </div>
        </div>
      </header>
      {error && !form && <div role="alert" className="ui-alert">{error}<Button variant="ghost" onClick={load}>{t('calendar.retry')}</Button></div>}
      {!writable.length && !loading && <div className="calendar-notice">{t('calendar.noWritable')}</div>}
      {loading && <div role="status" className="calendar-notice">{t('calendar.loading')}</div>}
      <div className="calendar-body" aria-busy={loading}>
        {view === 'agenda' ? <CalendarAgenda {...agendaProps} monthly /> : <CalendarGrid days={days} events={visibleEvents} view={view} anchor={anchor} isMobile={isMobile} locale={locale} onSelectDay={selectDay} openCreate={openCreate} openEdit={openEvent} openContextMenu={(event, x, y, trigger) => setContextMenu({ event, x, y, triggerRef: { current: trigger } })} t={t} calendarWorkHoursStart={calendarWorkHoursStart} calendarWorkHoursEnd={calendarWorkHoursEnd} />}
      </div>
    </main>
    {!compact && <aside className="calendar-agenda" aria-label={t('calendar.dayAgenda')}><CalendarAgenda {...agendaProps} /></aside>}
    {compact && dayPanelOpen && <Dialog title={t('calendar.dayAgenda')} closeLabel={t('calendar.close')} onClose={() => setDayPanelOpen(false)} className="calendar-day-dialog ui-drawer-right"><CalendarAgenda {...agendaProps} /></Dialog>}
    {isMobile && mobilePanelOpen && <Dialog title={t('calendar.panel')} closeLabel={t('calendar.close')} onClose={() => setMobilePanelOpen(false)} testId="calendar-mobile-dock" className="calendar-panel-dialog ui-drawer-left">
      <CalendarSidebar {...sidebarProps} onSelectDate={day => { setAnchor(day); setMobilePanelOpen(false); }} onClose={() => setMobilePanelOpen(false)} />
    </Dialog>}
    {isMobile && !mobilePanelOpen && !dayPanelOpen && <button data-testid="calendar-mobile-new-event" aria-label={t('calendar.newEvent')} disabled={!writable.length} onClick={() => openCreate()} style={{ ...mobileNewEventButton, bottom: mobileNavigationPosition === 'bottom' ? 'calc(var(--calendar-toolbar-height) + var(--sab) + 20px)' : 'calc(var(--mobile-nav-height) + var(--sab) + 20px)' }}>
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
    </button>}
    {form && <EventDialog form={form} error={error} calendars={writable} accounts={senderAccounts} saving={saving} onChange={changeForm} onAllDayChange={allDay => { invitationOperation.current.reset(); setForm(current => toggleAllDayTimes(current, allDay)); }} onSave={save} onDelete={remove} onClose={() => { invitationOperation.current.reset(); setForm(null); setError(null); }} t={t} />}
    {preview && <Dialog title={preview.summary || t('calendar.untitled')} closeLabel={t('calendar.close')} onClose={() => setPreview(null)} testId="calendar-event-preview">
      <div className="ui-form"><span className="calendar-readonly">{t('calendar.readOnly')}</span>
        <p>{preview.all_day ? `${String(preview.starts_at).slice(0, 10)} · ${t('calendar.allDay')}` : `${new Date(preview.starts_at).toLocaleString(locale)} – ${new Date(preview.ends_at).toLocaleString(locale)}`}</p>
        {preview.location && <p>{preview.location}</p>}{preview.description && <p style={{ whiteSpace: 'pre-wrap' }}>{preview.description}</p>}
        {preview.organizer && <p>{t('calendar.organizer')}: {preview.organizer}</p>}
      </div>
    </Dialog>}
    {contextMenu && <CalendarContextMenu {...contextMenu} isMobile={isMobile} onEdit={() => openEdit(contextMenu.event)} onDelete={() => deleteEvent(contextMenu.event)} onClose={() => setContextMenu(null)} t={t} />}
  </div>;
}

function CalendarGrid({ days, events, view, anchor, isMobile, locale, onSelectDay, openCreate, openEdit, openContextMenu, t, calendarWorkHoursStart, calendarWorkHoursEnd }) {
  const month = view === 'month';
  if (!month) return <TimeGrid days={days} events={events} view={view} isMobile={isMobile} locale={locale} openCreate={openCreate} openEdit={openEdit} openContextMenu={openContextMenu} onSelectDay={onSelectDay} anchor={anchor} t={t} calendarWorkHoursStart={calendarWorkHoursStart} calendarWorkHoursEnd={calendarWorkHoursEnd} />;
  return <div data-testid="calendar-grid" style={{ ...calendarSurface, flex: 1, minWidth: 0 }}>
    <div style={monthDow}>{days.slice(0, 7).map(day => <div key={`header-${day.toISOString()}`} style={monthDowCell}><span data-testid="calendar-weekday" style={monthDowLabel}>{day.toLocaleDateString(locale, { weekday: 'long' })}</span></div>)}</div>
    <div data-testid="calendar-month-grid" style={{ ...dayGrid, gridTemplateColumns: `repeat(7, minmax(${isMobile && !month ? 112 : 0}px, 1fr))`, gridAutoRows: 'minmax(108px, 1fr)', gap: 1, background: 'var(--border-subtle)', borderTop: '1px solid var(--border-subtle)' }}>
      {days.map(day => {
        const inMonth = day.getMonth() === anchor.getMonth(); const dayEvents = sortedDayEvents(events, day); const visibleDayEvents = dayEvents.slice(0, 3); const hiddenCount = dayEvents.length - visibleDayEvents.length;
        return <section key={day.toDateString()} className="cal-cell" data-selected={day.toDateString() === anchor.toDateString()} onClick={event => { if (event.target === event.currentTarget) onSelectDay(day); }} onDoubleClick={event => { if (event.target === event.currentTarget) openCreate(day); }} style={{ ...monthCell, ...(isWeekend(day) ? weekendCell : {}), ...(inMonth ? {} : outCell) }}>
          <button type="button" className="calendar-day-select" aria-label={day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} aria-pressed={day.toDateString() === anchor.toDateString()} onClick={() => onSelectDay(day)} style={{ ...dateChip, ...(isToday(day) ? dateChipToday : {}) }}>{day.getDate()}</button>
          <div style={eventStack}>{visibleDayEvents.map(event => {
            const showMenu = target => openContextMenu(event, target.clientX, target.clientY, target.currentTarget);
            const invokeMenu = keyboardEvent => {
              if (keyboardEvent.key !== 'ContextMenu' && !(keyboardEvent.shiftKey && keyboardEvent.key === 'F10')) return;
              keyboardEvent.preventDefault();
              openContextMenu(event, keyboardEvent.currentTarget.getBoundingClientRect().right, keyboardEvent.currentTarget.getBoundingClientRect().bottom, keyboardEvent.currentTarget);
            };
            return <div key={event.id} style={eventRow}>
              <button className="cal-ev" onClick={() => openEdit(event)} onContextMenu={event => { event.preventDefault(); showMenu(event); }} onKeyDown={invokeMenu} title={event.read_only ? t('calendar.readOnly') : t('calendar.edit')} style={{ ...eventCard, background: event.calendar_color || 'var(--accent)', cursor: 'pointer' }}>{!(event.all_day || event.allDay) && <strong style={eventCardTime}>{eventTime(event)}</strong>}<span>{month ? event.summary || t('calendar.untitled') : `${eventTime(event)}  ${event.summary || t('calendar.untitled')}`}</span>{!month && event.location && <small>{event.location}</small>}</button>
            </div>;
          })}{hiddenCount > 0 && <button type="button" className="calendar-more" onClick={() => onSelectDay(day)} style={eventMoreChip}>{t('calendar.moreEvents', { n: hiddenCount })}</button>}</div>
        </section>;
      })}
    </div>
  </div>;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '09:00').split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function TimeGrid({ days, events, view, isMobile, locale, openCreate, openEdit, openContextMenu, onSelectDay, anchor, t, calendarWorkHoursStart, calendarWorkHoursEnd }) {
  const scroller = useRef(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, Math.min(timeToMinutes(calendarWorkHoursStart), timeToMinutes(calendarWorkHoursEnd)) - 120);
  }, [calendarWorkHoursEnd, calendarWorkHoursStart, view]);
  const columns = `52px repeat(${days.length}, minmax(${isMobile ? 150 : 0}px, 1fr))`;
  const workHours = workHoursGeometry(calendarWorkHoursStart, calendarWorkHoursEnd);
  const allDayEvents = days.map(day => eventsForDay(events, day).filter(event => event.all_day || event.allDay));
  const showMenu = (event, target) => openContextMenu(event, target.clientX, target.clientY, target.currentTarget);
  const invokeMenu = (event, keyboardEvent) => {
    if (keyboardEvent.key !== 'ContextMenu' && !(keyboardEvent.shiftKey && keyboardEvent.key === 'F10')) return;
    keyboardEvent.preventDefault();
    const target = keyboardEvent.currentTarget;
    const rect = target.getBoundingClientRect();
    openContextMenu(event, rect.right, rect.bottom, target);
  };
  return <div data-testid="calendar-grid" style={{ ...calendarSurface, flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
    <div data-testid="calendar-time-grid-scroll" ref={scroller} style={{ overflowAnchor: 'none', width: isMobile ? 52 + days.length * 150 : '100%', overflowY: 'auto', overflowX: 'visible', height: '100%', minHeight: 0 }}>
      <div style={{ width: isMobile ? 52 + days.length * 150 : '100%', minWidth: isMobile ? 52 + days.length * 150 : 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: columns, position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-secondary)' }}>
          <div style={timeAxisHeader} />{days.map(day => <button type="button" key={day.toDateString()} aria-label={day.toLocaleDateString(locale, { dateStyle: 'full' })} aria-pressed={day.toDateString() === anchor.toDateString()} onClick={() => onSelectDay(day)} style={{ ...dayHeader, borderTop: 0, borderLeft: 0, borderRight: 0, cursor: 'pointer' }}><span style={dayHeaderWeekday}>{day.toLocaleDateString(locale, { weekday: 'short' })}</span><strong style={{ ...dayHeaderDay, ...(isToday(day) ? todayDayChip : {}) }}>{day.getDate()}</strong></button>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: columns, borderBottom: '1px solid var(--border)' }}>
          <div style={allDayLabel}>{t('calendar.allDay')}</div>{allDayEvents.map((dayEvents, index) => <div key={days[index].toDateString()} style={allDayCell}>{dayEvents.map(event => <div key={event.id} style={eventRow}><button className="cal-ev" onClick={() => openEdit(event)} onContextMenu={keyboardEvent => { keyboardEvent.preventDefault(); showMenu(event, keyboardEvent); }} onKeyDown={keyboardEvent => invokeMenu(event, keyboardEvent)} title={event.read_only ? t('calendar.readOnly') : t('calendar.edit')} style={{ ...eventCard, background: event.calendar_color || 'var(--accent)' }}>{event.summary || t('calendar.untitled')}</button>{isMobile && <button type="button" data-testid="calendar-event-actions" aria-label={t('calendar.eventActions', 'Event actions')} onClick={target => showMenu(event, target)} style={eventActionButton}>⋮</button>}</div>)}</div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: columns }}>
          <div style={timeAxis}>{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ ...timeAxisSpan, top: hour * 60 }}>{`${String(hour).padStart(2, '0')}:00`}</span>)}</div>
          {days.map(day => {
            const dayEvents = eventsForDay(events, day);
            const timed = layoutTimedEvents(dayEvents, day);
            return <div key={day.toDateString()} onDoubleClick={() => openCreate(day)} style={{ ...timeColumn, ...(isWeekend(day) ? weekendColumn : {}) }}>{Array.from({ length: 24 }, (_, hour) => <i key={hour} style={{ top: hour * 60 }} />)}<div aria-label={`${t('calendar.workHoursStart', 'Working hours start')} ${calendarWorkHoursStart} – ${t('calendar.workHoursEnd', 'Working hours end')} ${calendarWorkHoursEnd}`} data-testid="calendar-work-hours-boundary" style={{ ...workHoursBoundary, ...(isToday(day) ? workHoursBoundaryToday : {}), top: workHours.start, height: Math.max(0, workHours.end - workHours.start) }} />{isToday(day) && <div aria-hidden="true" style={{ ...nowLine, top: nowMinutes() }}><span style={nowLineDot} /></div>}{timed.map(({ event, geometry, column, columns: count }) => <div key={event.id} style={{ ...timedEvent, top: geometry.start, height: Math.max(18, geometry.end - geometry.start), left: `calc(${column * 100 / count}% + 3px)`, width: `calc(${100 / count}% - 6px)`, padding: 0, display: 'flex', overflow: 'visible' }}><button className="cal-ev" onClick={() => openEdit(event)} onContextMenu={keyboardEvent => { keyboardEvent.preventDefault(); showMenu(event, keyboardEvent); }} onKeyDown={keyboardEvent => invokeMenu(event, keyboardEvent)} title={event.read_only ? t('calendar.readOnly') : t('calendar.edit')} style={{ ...timedEvent, position: 'absolute', inset: 0, width: '100%', height: '100%', background: event.calendar_color || 'var(--accent)', cursor: event.read_only || event.source !== 'local' ? 'default' : 'pointer' }}><strong style={timedEventTime}>{eventTime(event)}</strong> {event.summary || t('calendar.untitled')}{geometry.end - geometry.start > 30 && event.location && <span style={timedEventLoc}>{event.location}</span>}</button>{isMobile && <button type="button" data-testid="calendar-event-actions" aria-label={t('calendar.eventActions', 'Event actions')} onClick={target => showMenu(event, target)} style={{ ...eventActionButton, position: 'absolute', top: 0, right: 0, zIndex: 2 }}>⋮</button>}</div>)}</div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}

function EventDialog({ form, error, calendars, accounts, saving, onChange, onAllDayChange, onSave, onDelete, onClose, t }) {
  const attendeeValue = form.attendees.join(', ');
  return <Dialog title={form.mode === 'edit' ? t('calendar.editEvent') : t('calendar.newEvent')} closeLabel={t('calendar.close')} onClose={onClose} busy={saving} testId="calendar-event-dialog" footer={<>
    <div>{form.mode === 'edit' && <Button variant="danger" disabled={saving} onClick={onDelete}>{t('calendar.delete')}</Button>}</div>
    <div style={{ display: 'flex', gap: 8 }}><Button disabled={saving} onClick={onClose}>{t('calendar.cancel')}</Button><Button variant="primary" disabled={saving} onClick={onSave}>{saving ? t('calendar.saving') : form.invitationError ? t('calendar.retrySave') : t('calendar.save')}</Button></div>
  </>}>
    <div className="ui-form">
      {error && <div role="alert" className="ui-alert">{error}</div>}
      <label>{t('calendar.titleField')}<input autoFocus value={form.summary} onChange={e => onChange('summary', e.target.value)} /></label>
      <label className="ui-check"><input type="checkbox" checked={form.allDay} onChange={e => onAllDayChange(e.target.checked)} />{t('calendar.allDay')}</label>
      <div className="ui-form-columns"><label>{t('calendar.starts')}<input type={form.allDay ? 'date' : 'datetime-local'} value={form.startsAt} onChange={e => onChange('startsAt', e.target.value)} /></label><label>{t('calendar.ends')}<input type={form.allDay ? 'date' : 'datetime-local'} value={form.endsAt} onChange={e => onChange('endsAt', e.target.value)} /></label></div>
      <label>{t('calendar.calendar')}<select value={form.calendarId} onChange={e => onChange('calendarId', e.target.value)}>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
      <label>{t('calendar.location')}<input value={form.location} onChange={e => onChange('location', e.target.value)} /></label>
      <label>{t('calendar.description')}<textarea rows="4" value={form.description} onChange={e => onChange('description', e.target.value)} /></label>
      <div className="calendar-invites ui-form"><label className="ui-check"><input type="checkbox" checked={form.sendInvites} onChange={e => onChange('sendInvites', e.target.checked)} />{t('calendar.sendInvites')}</label>
        {form.sendInvites && <><label>{t('calendar.attendees')}<input value={attendeeValue} onChange={e => onChange('attendees', e.target.value.split(',').map(email => email.trim()).filter(Boolean))} placeholder={t('calendar.attendeesPlaceholder')} /></label>
          <label>{t('calendar.senderAccount')}<select value={form.inviteAccountId} onChange={e => onChange('inviteAccountId', e.target.value)}><option value="">{t('calendar.chooseSender')}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name || account.email_address} · {account.email_address}</option>)}</select></label>
          {!accounts.length && <p>{t('calendar.noSenderAccounts')}</p>}</>}
      </div>
    </div>
  </Dialog>;
}

const mobileNewEventButton = { position: 'fixed', right: 20, bottom: 'max(20px, calc(env(safe-area-inset-bottom) + 12px))', zIndex: 10, width: 56, height: 56, border: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--accent)', color: 'var(--accent-text)', boxShadow: '0 8px 22px rgba(0,0,0,.28)', cursor: 'pointer' };

 const calendarSurface = { overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-secondary)' }; const dayGrid = { display: 'grid', flex: 1, minWidth: 0 }; const dayHeader = { position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0, padding: '7px 6px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }; const dayHeaderWeekday = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 9.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }; const dayHeaderDay = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }; const todayDayChip = { background: 'var(--accent)', color: 'var(--accent-text)', width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }; const monthCell = { minWidth: 0, padding: 6, background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 108, boxSizing: 'border-box', cursor: 'pointer' }; const outCell = { opacity: .5 }; const weekendCell = { background: 'color-mix(in srgb, var(--bg-secondary) 55%, var(--bg-primary))' }; const dateChip = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }; const dateChipToday = { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 600 }; const eventStack = { display: 'grid', minWidth: 0, gap: 2 }; const eventRow = { display: 'flex', minWidth: 0, gap: 2 }; const eventCard = { display: 'block', minWidth: 0, gap: 2, flex: 1, width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '2px 6px', color: 'white', fontSize: 11, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }; const eventCardTime = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 9.5, fontWeight: 400, opacity: .85, marginRight: 4 }; const eventActionButton = { flexShrink: 0, width: 44, minWidth: 44, height: 44, minHeight: 44, border: 0, borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 18, lineHeight: 1 };
const timeAxisHeader = { borderRight: '1px solid var(--border-subtle)' }; const allDayLabel = { padding: '8px 6px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, borderRight: '1px solid var(--border-subtle)' }; const allDayCell = { minHeight: 30, padding: 2, background: 'var(--bg-primary)', borderRight: '1px solid var(--border-subtle)', display: 'grid', gap: 2, alignContent: 'start' }; const timeAxis = { position: 'relative', height: 1440, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontSize: 10 }; const timeAxisSpan = { position: 'absolute', right: 8, transform: 'translateY(-50%)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 9.5, color: 'var(--text-tertiary)' }; const timeColumn = { position: 'relative', height: 1440, background: 'var(--bg-primary)', borderRight: '1px solid var(--border-subtle)', backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 59px, var(--border-subtle) 59px, var(--border-subtle) 60px)' }; const weekendColumn = { background: 'color-mix(in srgb, var(--bg-secondary) 55%, var(--bg-primary))' }; const timedEvent = { position: 'absolute', zIndex: 1, margin: 0, overflow: 'hidden', border: 0, borderRadius: 4, padding: '2px 6px', color: 'white', textAlign: 'left', fontSize: 11, lineHeight: 1.45, boxSizing: 'border-box' }; const timedEventTime = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 9.5, fontWeight: 400, opacity: .85, marginRight: 2 }; const timedEventLoc = { display: 'block', fontSize: 10, opacity: .8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const workHoursBoundary = { position: 'absolute', left: 0, right: 0, zIndex: 0, borderTop: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', background: 'color-mix(in srgb, var(--accent) 5%, transparent)', pointerEvents: 'none' }; const workHoursBoundaryToday = { background: 'color-mix(in srgb, var(--accent) 7%, transparent)' };
const nowLine = { position: 'absolute', left: 0, right: 0, height: 2, background: 'var(--red)', zIndex: 4, pointerEvents: 'none' }; const nowLineDot = { position: 'absolute', left: -1, top: -3, width: 8, height: 8, borderRadius: '50%', background: 'var(--red)' };

const monthDow = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' };
const monthDowCell = { minWidth: 0, overflow: 'hidden' };
const monthDowLabel = { display: 'block', padding: '7px 8px', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const eventMoreChip = { display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' };
