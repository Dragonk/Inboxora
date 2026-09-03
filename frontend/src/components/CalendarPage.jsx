import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { eventPayload, eventsForDay, layoutTimedEvents, monthRange, shiftCalendarAnchor, toDateTimeLocal, toggleAllDayTimes, weekRange, workHoursGeometry } from './calendarView.js';
import CalendarSidebar from './CalendarSidebar.jsx';
import { createInvitationOperationController } from './calendarInvitationRetry.js';
import CalendarContextMenu from './CalendarContextMenu.jsx';

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

export default function CalendarPage({ isActive = true }) {
  const { t, i18n } = useTranslation();
  const locale = resolveDateLocale(i18n.resolvedLanguage || i18n.language);
  const { showCalendar, setShowCalendar, setMobileSidebarOpen, accounts, calendarWeekStartsOn, calendarWorkDays, calendarWorkHoursStart, calendarWorkHoursEnd, visibleCalendarIds, setVisibleCalendarIds, mobileNavigationPosition } = useStore();
  const isMobile = useMobile();
  const [anchor, setAnchor] = useState(() => new Date());
  const loadGeneration = useRef(0);
  const [view, setView] = useState('month');
  const [calendars, setCalendars] = useState([]); const [events, setEvents] = useState([]);
  const [error, setError] = useState(null); const [loading, setLoading] = useState(true); const [form, setForm] = useState(null); const [saving, setSaving] = useState(false); const [sourcePanelRequest, setSourcePanelRequest] = useState(0);
  const invitationOperation = useRef(null);
  if (!invitationOperation.current) invitationOperation.current = createInvitationOperationController();
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const range = useMemo(() => view === 'month' ? monthRange(anchor) : weekRange(anchor, calendarWeekStartsOn), [anchor, calendarWeekStartsOn, view]);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError(null);
    try { const [calendarResult, eventResult] = await Promise.all([api.calendar.listCalendars(), api.calendar.listEvents(iso(range.start), iso(range.end))]); if (generation === loadGeneration.current) { setCalendars(calendarResult.calendars || []); setEvents(eventResult.events || []); } }
    catch (err) { if (generation === loadGeneration.current) setError(err.message || t('calendar.loadFailed')); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [range, t]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isMobile || !isActive) return;
    invitationOperation.current.reset();
    setForm(null);
    setMobilePanelOpen(false);
    document.getElementById('calendar-mobile-panel')?.close();
  }, [isActive, isMobile]);
  useEffect(() => {
    if (!isMobile || !showCalendar || !form) return undefined;
    const handleBack = event => { event.preventDefault(); invitationOperation.current.reset(); setForm(null); };
    window.addEventListener('inboxora:back', handleBack);
    return () => window.removeEventListener('inboxora:back', handleBack);
  }, [form, isMobile, showCalendar]);
  const writable = calendars.filter(calendar => !calendar.read_only && calendar.source === 'local');
  const senderAccounts = accounts.filter(account => account.enabled && account.smtp_host);
  const openCreate = (date = new Date()) => { invitationOperation.current.reset(); setForm({ ...emptyForm(writable[0]?.id || '', date), mode: 'create' }); };
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
  const title = view === 'month'
    ? anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
    : `${days[0].toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${days.at(-1).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const step = direction => setAnchor(current => shiftCalendarAnchor(current, view, direction));
  const shiftMiniMonth = direction => setAnchor(current => shiftCalendarAnchor(current, 'month', direction));
  return <div data-testid="calendar-page" style={{ ...page, ...(isMobile ? mobilePage : {}) }}>
    <header style={{ ...header, ...(isMobile ? mobileHeader(mobileNavigationPosition) : {}) }}>
      {isMobile && <button data-testid="calendar-mobile-menu" aria-label={t('messageList.menu', 'Menu')} onClick={() => setMobileSidebarOpen(true)} style={mobileBackButton}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>}
      {isMobile && <button data-testid="calendar-mobile-back" aria-label={t('calendar.back')} onClick={() => setShowCalendar(false)} style={mobileBackButton}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
      </button>}
      <div style={{ ...heading, ...(isMobile ? mobileHeading : {}) }}><h1 style={{ margin: 0, fontSize: 22 }}>{t('calendar.title')}</h1><span style={subheading}>{title}</span></div>
      <div style={{ ...toolbar, ...(isMobile ? mobileToolbar : {}) }}>
        <div role="group" style={segmented} aria-label={t('calendar.view')}>
          {[['month', t('calendar.month')], ['week', t('calendar.week')], ['workweek', t('calendar.workWeek')]].map(([value, label]) => <button key={value} data-testid={`calendar-view-${value}`} onClick={() => setView(value)} aria-pressed={view === value} style={{ ...segmentButton, ...(view === value ? segmentActive : {}) }}>{label}</button>)}
        </div>
        <button onClick={() => step(-1)} aria-label={t('calendar.previous')} style={iconButton}>‹</button><button onClick={() => setAnchor(new Date())} style={secondaryButton}>{t('calendar.today')}</button><button onClick={() => step(1)} aria-label={t('calendar.next')} style={iconButton}>›</button>
        {isMobile && <button data-testid="calendar-mobile-panel" onClick={() => { document.getElementById('calendar-mobile-panel')?.show(); setMobilePanelOpen(true); }} style={secondaryButton}>{t('calendar.calendars')}</button>}
        <button data-testid="calendar-manage-sources" onClick={() => { setSourcePanelRequest(request => request + 1); if (isMobile) { document.getElementById('calendar-mobile-panel')?.show(); setMobilePanelOpen(true); } }} style={secondaryButton}>{t('calendar.manageSources')}</button>
        {!isMobile && <button disabled={!writable.length} onClick={() => openCreate()} style={primaryButton}>{t('calendar.newEvent')}</button>}
      </div>
    </header>
    {error && <div role="alert" style={errorStyle}>{error}</div>}
    {!writable.length && !loading && <div style={errorStyle}>{t('calendar.noWritable')}</div>}
    <div style={calendarContent}>
      {!isMobile && <CalendarSidebar anchor={anchor} calendars={calendars} visibleCalendarIds={visibleCalendarIds} weekStartsOn={calendarWeekStartsOn} locale={locale} onSelectDate={setAnchor} onShiftMonth={shiftMiniMonth} onToggleCalendar={toggleCalendar} onSourcesChanged={load} sourcePanelRequest={sourcePanelRequest} t={t} />}
      <CalendarGrid days={days} events={visibleEvents} view={view} anchor={anchor} isMobile={isMobile} locale={locale} openCreate={openCreate} openEdit={openEdit} openContextMenu={(event, x, y, trigger) => setContextMenu({ event, x, y, triggerRef: { current: trigger } })} t={t} calendarWorkHoursStart={calendarWorkHoursStart} calendarWorkHoursEnd={calendarWorkHoursEnd} />
    </div>
    {isMobile && <dialog id="calendar-mobile-panel" aria-label={t('calendar.panel')} data-testid="calendar-mobile-dock" onClose={() => setMobilePanelOpen(false)} style={mobilePanelDialog}><CalendarSidebar anchor={anchor} calendars={calendars} visibleCalendarIds={visibleCalendarIds} weekStartsOn={calendarWeekStartsOn} locale={locale} onSelectDate={day => { setAnchor(day); document.getElementById('calendar-mobile-panel')?.close(); }} onShiftMonth={shiftMiniMonth} onToggleCalendar={toggleCalendar} onSourcesChanged={load} onClose={() => document.getElementById('calendar-mobile-panel')?.close()} sourcePanelRequest={sourcePanelRequest} t={t} /></dialog>}
    {isMobile && !mobilePanelOpen && <button data-testid="calendar-mobile-new-event" aria-label={t('calendar.newEvent')} disabled={!writable.length} onClick={() => openCreate()} style={{ ...mobileNewEventButton, bottom: 'calc(var(--mobile-nav-height) + var(--sab) + 20px)' }}>
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
    </button>}
    {loading && <p>{t('calendar.loading')}</p>}
    {form && <EventDialog form={form} calendars={writable} accounts={senderAccounts} isMobile={isMobile} saving={saving} onChange={changeForm} onAllDayChange={allDay => { invitationOperation.current.reset(); setForm(current => toggleAllDayTimes(current, allDay)); }} onSave={save} onDelete={remove} onClose={() => { invitationOperation.current.reset(); setForm(null); }} t={t} />}
    {contextMenu && <CalendarContextMenu {...contextMenu} isMobile={isMobile} onEdit={() => openEdit(contextMenu.event)} onDelete={() => deleteEvent(contextMenu.event)} onClose={() => setContextMenu(null)} t={t} />}
  </div>;
}

function CalendarGrid({ days, events, view, anchor, isMobile, locale, openCreate, openEdit, openContextMenu, t, calendarWorkHoursStart, calendarWorkHoursEnd }) {
  const month = view === 'month';
  if (!month) return <TimeGrid days={days} events={events} isMobile={isMobile} locale={locale} openCreate={openCreate} openEdit={openEdit} t={t} calendarWorkHoursStart={calendarWorkHoursStart} calendarWorkHoursEnd={calendarWorkHoursEnd} />;
  return <div data-testid="calendar-grid" style={{ ...calendarSurface, flex: 1, minWidth: 0 }}>
    <div data-testid={month ? 'calendar-month-grid' : undefined} style={{ ...dayGrid, gridTemplateColumns: `repeat(${month ? 7 : days.length}, minmax(${isMobile && !month ? 112 : 0}px, 1fr))` }}>
      {days.slice(0, month ? 7 : days.length).map(day => <div key={`header-${day.toISOString()}`} style={{ ...dayHeader, ...(isToday(day) ? todayHeader : {}) }}><span data-testid="calendar-weekday">{day.toLocaleDateString(locale, { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}
      {days.map(day => {
        const inMonth = day.getMonth() === anchor.getMonth(); const dayEvents = eventsForDay(events, day);
        return <section key={day.toDateString()} onDoubleClick={() => openCreate(day)} style={{ ...dayCell, minHeight: month ? 132 : 580, opacity: month && !inMonth ? .46 : 1, ...(isToday(day) ? todayCell : {}) }}>
          {month && <div style={dateChip}>{day.getDate()}</div>}
          <div style={eventStack}>{dayEvents.map(event => {
            const writable = !event.read_only && event.source === 'local';
            const showMenu = target => openContextMenu(event, target.clientX, target.clientY, target.currentTarget);
            const invokeMenu = keyboardEvent => {
              if (keyboardEvent.key !== 'ContextMenu' && !(keyboardEvent.shiftKey && keyboardEvent.key === 'F10')) return;
              keyboardEvent.preventDefault();
              openContextMenu(event, keyboardEvent.currentTarget.getBoundingClientRect().right, keyboardEvent.currentTarget.getBoundingClientRect().bottom, keyboardEvent.currentTarget);
            };
            return <div key={event.id} style={eventRow}>
              <button onClick={() => writable ? openEdit(event) : null} onContextMenu={event => { event.preventDefault(); showMenu(event); }} onKeyDown={invokeMenu} title={event.read_only ? t('calendar.readOnly') : t('calendar.edit')} style={{ ...eventCard, background: event.calendar_color || 'var(--accent)', cursor: writable ? 'pointer' : 'default' }}><span>{month ? event.summary || t('calendar.untitled') : `${eventTime(event)}  ${event.summary || t('calendar.untitled')}`}</span>{!month && event.location && <small>{event.location}</small>}</button>
              {isMobile && <button type="button" data-testid="calendar-event-actions" aria-label={t('calendar.eventActions', 'Event actions')} onClick={event => showMenu(event)} style={eventActionButton}>⋮</button>}
            </div>;
          })}</div>
        </section>;
      })}
    </div>
  </div>;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '09:00').split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function TimeGrid({ days, events, isMobile, locale, openCreate, openEdit, t, calendarWorkHoursStart, calendarWorkHoursEnd }) {
  const scroller = useRef(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, Math.min(timeToMinutes(calendarWorkHoursStart), timeToMinutes(calendarWorkHoursEnd)) - 120);
  }, [calendarWorkHoursEnd, calendarWorkHoursStart]);
  const columns = `72px repeat(${days.length}, minmax(${isMobile ? 150 : 0}px, 1fr))`;
  const workHours = workHoursGeometry(calendarWorkHoursStart, calendarWorkHoursEnd);
  const allDayEvents = days.map(day => eventsForDay(events, day).filter(event => event.all_day || event.allDay));
  return <div data-testid="calendar-grid" style={{ ...calendarSurface, flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
    <div data-testid="calendar-time-grid-scroll" ref={scroller} style={{ width: isMobile ? 72 + days.length * 150 : '100%', overflowY: 'auto', overflowX: 'visible', maxHeight: 'min(72vh, 760px)' }}>
      <div style={{ width: isMobile ? 72 + days.length * 150 : '100%', minWidth: isMobile ? 72 + days.length * 150 : 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: columns, position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg-secondary)' }}>
          <div style={timeAxisHeader} />{days.map(day => <div key={day.toDateString()} style={{ ...dayHeader, ...(isToday(day) ? todayHeader : {}) }}><span>{day.toLocaleDateString(locale, { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: columns, borderBottom: '1px solid var(--border)' }}>
          <div style={allDayLabel}>{t('calendar.allDay')}</div>{allDayEvents.map((dayEvents, index) => <div key={days[index].toDateString()} style={allDayCell}>{dayEvents.map(event => <button key={event.id} onClick={() => !event.read_only && event.source === 'local' && openEdit(event)} style={{ ...eventCard, background: event.calendar_color || 'var(--accent)' }}>{event.summary || t('calendar.untitled')}</button>)}</div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: columns }}>
          <div style={timeAxis}>{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={timeAxisSpan}>{`${String(hour).padStart(2, '0')}:00`}</span>)}</div>
          {days.map(day => {
            const dayEvents = eventsForDay(events, day);
            const timed = layoutTimedEvents(dayEvents, day);
            return <div key={day.toDateString()} onDoubleClick={() => openCreate(day)} style={timeColumn}>{Array.from({ length: 24 }, (_, hour) => <i key={hour} style={{ top: hour * 60 }} />)}<div aria-label={`${t('calendar.workHoursStart', 'Working hours start')} ${calendarWorkHoursStart} – ${t('calendar.workHoursEnd', 'Working hours end')} ${calendarWorkHoursEnd}`} data-testid="calendar-work-hours-boundary" style={{ ...workHoursBoundary, top: workHours.start, height: Math.max(0, workHours.end - workHours.start) }} />{timed.map(({ event, geometry, column, columns: count }) => <button key={event.id} onClick={() => !event.read_only && event.source === 'local' && openEdit(event)} title={event.read_only ? t('calendar.readOnly') : t('calendar.edit')} style={{ ...timedEvent, top: geometry.start, height: Math.max(18, geometry.end - geometry.start), left: `calc(${column * 100 / count}% + 3px)`, width: `calc(${100 / count}% - 6px)`, background: event.calendar_color || 'var(--accent)', cursor: event.read_only || event.source !== 'local' ? 'default' : 'pointer' }}><strong>{eventTime(event)}</strong> {event.summary || t('calendar.untitled')}</button>)}</div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}

function EventDialog({ form, calendars, accounts, isMobile, saving, onChange, onAllDayChange, onSave, onDelete, onClose, t }) {
  const attendeeValue = form.attendees.join(', ');
  const setAttendees = value => onChange('attendees', value.split(',').map(email => email.trim()).filter(Boolean));
  return <div role="dialog" aria-modal="true" aria-label={form.mode === 'edit' ? t('calendar.editEvent') : t('calendar.newEvent')} style={overlay}><div data-testid="calendar-event-dialog" style={{ ...dialog, ...(isMobile ? mobileDialog : {}) }}>
    <header style={dialogHeader}><h2 style={{ margin: 0 }}>{form.mode === 'edit' ? t('calendar.editEvent') : t('calendar.newEvent')}</h2><button aria-label={t('calendar.close')} onClick={onClose} style={iconButton}>×</button></header>
    <label style={field}><span>{t('calendar.titleField')}</span><input autoFocus value={form.summary} onChange={e => onChange('summary', e.target.value)} /></label>
    <label style={toggleLabel}><input type="checkbox" checked={form.allDay} onChange={e => onAllDayChange(e.target.checked)} />{t('calendar.allDay')}</label>
    <div style={isMobile ? mobileSingleColumn : twoColumns}><label style={field}><span>{t('calendar.starts')}</span><input type={form.allDay ? 'date' : 'datetime-local'} value={form.startsAt} onChange={e => onChange('startsAt', e.target.value)} /></label><label style={field}><span>{t('calendar.ends')}</span><input type={form.allDay ? 'date' : 'datetime-local'} value={form.endsAt} onChange={e => onChange('endsAt', e.target.value)} /></label></div>
    <label style={field}><span>{t('calendar.calendar')}</span><select value={form.calendarId} onChange={e => onChange('calendarId', e.target.value)}>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
    <label style={field}><span>{t('calendar.location')}</span><input value={form.location} onChange={e => onChange('location', e.target.value)} /></label>
    <label style={field}><span>{t('calendar.description')}</span><textarea rows="4" value={form.description} onChange={e => onChange('description', e.target.value)} /></label>
    <div style={inviteBox}><label style={toggleLabel}><input type="checkbox" checked={form.sendInvites} onChange={e => onChange('sendInvites', e.target.checked)} />{t('calendar.sendInvites')}</label>{form.sendInvites && <><label style={field}><span>{t('calendar.attendees')}</span><input value={attendeeValue} onChange={e => setAttendees(e.target.value)} placeholder={t('calendar.attendeesPlaceholder')} /></label><label style={field}><span>{t('calendar.senderAccount')}</span><select value={form.inviteAccountId} onChange={e => onChange('inviteAccountId', e.target.value)}><option value="">{t('calendar.chooseSender')}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name || account.email_address} · {account.email_address}</option>)}</select></label>{!accounts.length && <p style={hint}>{t('calendar.noSenderAccounts')}</p>}</>}</div>
    <footer style={dialogFooter}><div>{form.mode === 'edit' && <button disabled={saving} onClick={onDelete} style={dangerButton}>{t('calendar.delete')}</button>}</div><div style={{ display: 'flex', gap: 8 }}><button disabled={saving} onClick={onClose} style={secondaryButton}>{t('calendar.cancel')}</button><button disabled={saving} onClick={onSave} style={primaryButton}>{saving ? t('calendar.saving') : form.invitationError ? t('calendar.retrySave', 'Retry save') : t('calendar.save')}</button></div></footer>
  </div></div>;
}

const page = { display: 'flex', flexDirection: 'column', flex: 1, width: '100%', maxWidth: 'none', minWidth: 0, height: '100%', overflow: 'auto', padding: '24px clamp(14px, 3vw, 36px)', boxSizing: 'border-box', background: 'var(--bg-primary)' };
const mobilePage = { overflowX: 'hidden', paddingBottom: 'calc(var(--mobile-nav-height) + var(--sab) + 12px)' };
const header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 };
const mobileHeader = position => position === 'bottom' ? { position: 'sticky', bottom: 'calc(var(--mobile-nav-height) + var(--sab))', zIndex: 12, order: 2, margin: '16px -14px 0', padding: '10px 12px', flexWrap: 'wrap', background: 'var(--bg-primary)', borderTop: '1px solid var(--border-subtle)' } : { position: 'sticky', top: 0, zIndex: 2, margin: '0 -14px 16px', padding: 'calc(var(--sat) + 10px) 12px 10px', flexWrap: 'wrap', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' };
const mobileBackButton = { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44, flexShrink: 0 };
const mobileNewEventButton = { position: 'fixed', right: 20, bottom: 'max(20px, calc(env(safe-area-inset-bottom) + 12px))', zIndex: 10, width: 56, height: 56, border: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--accent)', color: 'var(--accent-text)', boxShadow: '0 8px 22px rgba(0,0,0,.28)', cursor: 'pointer' };
const calendarContent = { display: 'flex', flex: 1, width: '100%', minHeight: 0, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }; const mobilePanelDialog = { position: 'fixed', left: 0, right: 0, top: 'auto', bottom: 'calc(var(--mobile-nav-height) + var(--sab))', zIndex: 1100, border: 0, padding: 0, margin: 0, maxHeight: 'calc(100svh - var(--mobile-nav-height) - var(--sab) - 16px)', overflowY: 'auto', maxWidth: 'min(360px, 92vw)', width: '100%', background: 'transparent' };
const heading = { display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 230 }; const mobileHeading = { flex: 1, minWidth: 0 }; const subheading = { color: 'var(--text-secondary)', fontWeight: 600 };
const toolbar = { display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }; const mobileToolbar = { flexBasis: '100%', width: '100%' }; const segmented = { display: 'flex', padding: 3, borderRadius: 9, background: 'var(--bg-tertiary)' };
const segmentButton = { border: 0, background: 'transparent', color: 'var(--text-secondary)', padding: '6px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }; const segmentActive = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', boxShadow: '0 1px 3px rgba(0,0,0,.16)' };
const primaryButton = { background: 'var(--accent)', color: 'var(--accent-text)', border: 0, borderRadius: 7, padding: '8px 12px', cursor: 'pointer', fontWeight: 650 }; const secondaryButton = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 10px', cursor: 'pointer' }; const iconButton = { ...secondaryButton, padding: '5px 10px', fontSize: 18, lineHeight: 1 };
const errorStyle = { marginBottom: 12, padding: 10, borderRadius: 7, color: 'var(--red)', background: 'var(--red-dim, #fee2e2)' }; const calendarSurface = { overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-secondary)', boxShadow: '0 6px 24px rgba(0,0,0,.08)' }; const dayGrid = { display: 'grid', minWidth: 0 }; const dayHeader = { position: 'sticky', top: 0, zIndex: 1, display: 'flex', justifyContent: 'space-between', minWidth: 0, padding: '9px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', fontSize: 12 }; const todayHeader = { color: 'var(--accent)' }; const dayCell = { minWidth: 0, padding: 7, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', boxSizing: 'border-box' }; const todayCell = { background: 'color-mix(in srgb, var(--accent) 5%, transparent)' }; const dateChip = { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }; const eventStack = { display: 'grid', minWidth: 0, gap: 4 }; const eventRow = { display: 'flex', minWidth: 0, gap: 2 }; const eventCard = { display: 'grid', minWidth: 0, gap: 2, flex: 1, width: '100%', textAlign: 'left', border: 0, borderRadius: 6, padding: '5px 7px', color: 'white', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }; const eventActionButton = { flexShrink: 0, width: 28, border: 0, borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 18, lineHeight: 1 };
const timeAxisHeader = { borderRight: '1px solid var(--border)' }; const allDayLabel = { padding: '8px 6px', color: 'var(--text-tertiary)', fontSize: 11, borderRight: '1px solid var(--border)' }; const allDayCell = { minHeight: 38, padding: 4, borderRight: '1px solid var(--border)', display: 'grid', gap: 3, alignContent: 'start' }; const timeAxis = { position: 'relative', height: 1440, borderRight: '1px solid var(--border)', color: 'var(--text-tertiary)', fontSize: 10 }; const timeAxisSpan = { display: 'block', height: 60, padding: '3px 6px', boxSizing: 'border-box', textAlign: 'right' }; const timeColumn = { position: 'relative', height: 1440, borderRight: '1px solid var(--border)', backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 59px, var(--border) 59px, var(--border) 60px)' }; const timedEvent = { position: 'absolute', zIndex: 1, margin: 0, overflow: 'hidden', border: 0, borderRadius: 5, padding: '3px 5px', color: 'white', textAlign: 'left', fontSize: 11, lineHeight: '15px', boxSizing: 'border-box' };
const workHoursBoundary = { position: 'absolute', left: 0, right: 0, zIndex: 0, borderTop: '2px solid color-mix(in srgb, var(--accent) 70%, transparent)', borderBottom: '2px solid color-mix(in srgb, var(--accent) 70%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)', pointerEvents: 'none' };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, padding: 16, background: 'var(--overlay-scrim)', display: 'grid', placeItems: 'center' }; const dialog = { width: 590, maxWidth: '100%', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', padding: 22, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 14, display: 'grid', gap: 15, boxShadow: '0 24px 64px rgba(0,0,0,.3)' }; const mobileDialog = { width: 'calc(100vw - 32px)', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', boxSizing: 'border-box', padding: 16 }; const dialogHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }; const field = { display: 'grid', gap: 6, color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }; const twoColumns = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }; const mobileSingleColumn = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }; const inviteBox = { display: 'grid', gap: 11, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-primary)' }; const toggleLabel = { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }; const hint = { margin: 0, color: 'var(--text-secondary)', fontSize: 12 }; const dialogFooter = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginTop: 5 }; const dangerButton = { border: '1px solid var(--red)', background: 'transparent', color: 'var(--red)', borderRadius: 7, padding: '7px 10px', cursor: 'pointer' };
