import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { eventPayload, eventsForDay, monthRange, toDateTimeLocal } from './calendarView.js';

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const emptyForm = (calendarId = '', date = new Date()) => ({ calendarId, summary: '', description: '', location: '', url: '', organizer: '', allDay: false, startsAt: toDateTimeLocal(date), endsAt: toDateTimeLocal(new Date(date.getTime() + 3600000)) });
function iso(date) { return date.toISOString(); }
function calendarDays(anchor) {
  const { start } = monthRange(anchor); const first = new Date(start); first.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => { const day = new Date(first); day.setDate(day.getDate() + i); return day; });
}

export default function CalendarPage() {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState(() => new Date());
  const [calendars, setCalendars] = useState([]); const [events, setEvents] = useState([]);
  const [error, setError] = useState(null); const [loading, setLoading] = useState(true); const [form, setForm] = useState(null); const [saving, setSaving] = useState(false);
  const range = useMemo(() => monthRange(anchor), [anchor]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const [calendarResult, eventResult] = await Promise.all([api.calendar.listCalendars(), api.calendar.listEvents(iso(range.start), iso(range.end))]); setCalendars(calendarResult.calendars || []); setEvents(eventResult.events || []); }
    catch (err) { setError(err.message || 'Could not load calendar.'); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { load(); }, [load]);
  const writable = calendars.filter(calendar => !calendar.read_only && calendar.source === 'local');
  const openCreate = (date = new Date()) => setForm({ ...emptyForm(writable[0]?.id || '', date), mode: 'create' });
  const openEdit = event => setForm({ mode: 'edit', id: event.id, ...event, calendarId: event.calendar_id, summary: event.summary || '', description: event.description || '', location: event.location || '', url: event.url || '', organizer: event.organizer || '', startsAt: toDateTimeLocal(event.starts_at), endsAt: toDateTimeLocal(event.ends_at) });
  const save = async () => { const payload = eventPayload(form); if (!payload) { setError('Choose a local calendar and a valid end time after the start time.'); return; } setSaving(true); setError(null); try { if (form.mode === 'edit') await api.calendar.updateEvent(form.id, payload); else await api.calendar.createEvent(payload); setForm(null); await load(); } catch (err) { setError(err.message || 'Could not save event.'); } finally { setSaving(false); } };
  const remove = async () => { if (!form?.id || !window.confirm('Delete this event?')) return; setSaving(true); try { await api.calendar.deleteEvent(form.id, form.calendarId); setForm(null); await load(); } catch (err) { setError(err.message || 'Could not delete event.'); } finally { setSaving(false); } };
  const days = calendarDays(anchor); const title = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return <div data-testid="calendar-page" style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto', padding: 24, boxSizing: 'border-box' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}><h1 style={{ margin: 0, fontSize: 20, flex: 1 }}>{t('calendar.title')}</h1><button onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>‹</button><strong>{title}</strong><button onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>›</button><button onClick={() => setAnchor(new Date())}>{t('calendar.today')}</button><button disabled={!writable.length} onClick={() => openCreate()} style={primaryButton}>{t('calendar.newEvent')}</button></header>
    {error && <div role="alert" style={errorStyle}>{error}</div>}
    {!writable.length && !loading && <div style={errorStyle}>{t('calendar.noWritable')}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(110px, 1fr))', border: '1px solid var(--border)', minWidth: 770 }}>{dayNames.map(day => <div key={day} style={{ padding: 8, borderBottom: '1px solid var(--border)', color: 'var(--text-tertiary)', fontSize: 12 }}>{day}</div>)}{days.map(day => { const inMonth = day.getMonth() === anchor.getMonth(); const dayEvents = eventsForDay(events, day); return <div key={day.toDateString()} onDoubleClick={() => openCreate(day)} style={{ minHeight: 115, padding: 7, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', opacity: inMonth ? 1 : .5 }}><div style={{ fontSize: 12, marginBottom: 5 }}>{day.getDate()}</div>{dayEvents.map(event => <button key={event.id} onClick={() => !event.read_only && event.source === 'local' ? openEdit(event) : null} title={event.read_only ? 'Imported event (read-only)' : 'Edit event'} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 4, marginBottom: 3, padding: '3px 5px', background: event.calendar_color || 'var(--accent)', color: 'white', cursor: event.read_only || event.source !== 'local' ? 'default' : 'pointer', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.summary || '(Untitled event)'}</button>)}</div>; })}</div>
    {loading && <p>{t('calendar.loading')}</p>}
    {form && <EventDialog form={form} calendars={writable} saving={saving} onChange={(key, value) => setForm(current => ({ ...current, [key]: value }))} onSave={save} onDelete={remove} onClose={() => setForm(null)} />}
  </div>;
}
function EventDialog({ form, calendars, saving, onChange, onSave, onDelete, onClose }) { return <div role="dialog" aria-modal="true" style={overlay}><div style={dialog}><h2>{form.mode === 'edit' ? 'Edit event' : 'New event'}</h2><label>Calendar<select value={form.calendarId} onChange={e => onChange('calendarId', e.target.value)}>{calendars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Title<input autoFocus value={form.summary} onChange={e => onChange('summary', e.target.value)} /></label><label>Starts<input type="datetime-local" value={form.startsAt} onChange={e => onChange('startsAt', e.target.value)} /></label><label>Ends<input type="datetime-local" value={form.endsAt} onChange={e => onChange('endsAt', e.target.value)} /></label><label>Location<input value={form.location} onChange={e => onChange('location', e.target.value)} /></label><label>Description<textarea value={form.description} onChange={e => onChange('description', e.target.value)} /></label><div style={{ display: 'flex', gap: 8, marginTop: 18 }}><button disabled={saving} onClick={onSave} style={primaryButton}>{saving ? 'Saving…' : 'Save'}</button>{form.mode === 'edit' && <button disabled={saving} onClick={onDelete}>{'Delete'}</button>}<button disabled={saving} onClick={onClose}>{'Cancel'}</button></div></div></div>; }
const primaryButton = { background: 'var(--accent)', color: 'var(--accent-text)', border: 0, borderRadius: 6, padding: '7px 12px', cursor: 'pointer' }; const errorStyle = { marginBottom: 12, padding: 10, borderRadius: 6, color: 'var(--red)', background: 'var(--red-dim, #fee2e2)' }; const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay-scrim)', display: 'grid', placeItems: 'center' }; const dialog = { width: 440, maxWidth: 'calc(100vw - 32px)', padding: 24, background: 'var(--bg-secondary)', borderRadius: 10, display: 'grid', gap: 10 };
