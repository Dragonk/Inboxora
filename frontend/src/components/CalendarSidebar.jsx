import { useMemo, useState } from 'react';
import { api } from '../utils/api.js';

function monthCells(anchor, weekStartsOn) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  first.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    return date;
  });
}

export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn, onSelectDate, onToggleCalendar, onSourcesChanged, onClose, t }) {
  const [showSources, setShowSources] = useState(false);
  const [sources, setSources] = useState([]);
  const [sourceError, setSourceError] = useState(null);
  const [form, setForm] = useState({ kind: 'ical_url', displayName: '', url: '', username: '', password: '', color: '#7c6af7', intervalMin: 60 });
  const cells = useMemo(() => monthCells(anchor, weekStartsOn), [anchor, weekStartsOn]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + ((index + weekStartsOn) % 7)).toLocaleDateString(undefined, { weekday: 'narrow' })), [weekStartsOn]);
  const isVisible = id => visibleCalendarIds == null || visibleCalendarIds.includes(id);
  const loadSources = async () => {
    try { const result = await api.calendar.listSources(); setSources(result.sources || []); setSourceError(null); }
    catch (error) { setSourceError(error.message); }
  };
  const openSources = async () => { setShowSources(true); await loadSources(); };
  const addSource = async event => {
    event.preventDefault();
    try {
      await api.calendar.createSource({ ...form, password: form.kind === 'caldav' ? form.password : undefined, username: form.kind === 'caldav' ? form.username : undefined });
      setForm({ kind: 'ical_url', displayName: '', url: '', username: '', password: '', color: '#7c6af7', intervalMin: 60 });
      await loadSources();
      await onSourcesChanged();
    } catch (error) { setSourceError(error.message); }
  };
  const removeSource = async id => {
    try { await api.calendar.deleteSource(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(error.message); }
  };
  const syncSource = async id => {
    try { await api.calendar.syncSource(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(error.message); }
  };
  return <aside style={panel} aria-label={t('calendar.panel')}>
    {onClose && <div style={closeRow}><button data-testid="calendar-sidebar-close" aria-label={t('calendar.close')} onClick={onClose} style={linkButton}>{t('calendar.close')}</button></div>}

    <div data-testid="calendar-mini-month" style={miniMonth}>
      <strong>{anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
      <div style={weekdayGrid}>{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div>
      <div style={dayGrid}>{cells.map(day => <button key={day.toISOString()} onClick={() => onSelectDate(day)} style={{ ...dayButton, ...(day.toDateString() === new Date().toDateString() ? today : {}), ...(day.getMonth() !== anchor.getMonth() ? muted : {}) }}>{day.getDate()}</button>)}</div>
    </div>
    <section style={section}>
      <div style={sectionHeading}><strong>{t('calendar.calendars')}</strong><button data-testid="calendar-manage-sources" onClick={openSources} style={linkButton}>{t('calendar.manageSources')}</button></div>
      {calendars.map(calendar => <label key={calendar.id} style={calendarToggle}><input data-testid="calendar-visibility-toggle" type="checkbox" checked={isVisible(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} /><span style={{ ...colorDot, background: calendar.color || 'var(--accent)' }} />{calendar.name}{calendar.read_only && <small style={readOnly}>{t('calendar.readOnly')}</small>}</label>)}
    </section>
    {showSources && <div role="dialog" aria-modal="true" aria-label={t('calendar.manageSources')} style={overlay}><div style={dialog}>
      <header style={dialogHeader}><h2>{t('calendar.manageSources')}</h2><button onClick={() => setShowSources(false)} style={linkButton}>{t('calendar.close')}</button></header>
      {sourceError && <p role="alert" style={error}>{sourceError}</p>}
      <form onSubmit={addSource} style={formStyle}>
        <label>{t('calendar.sourceType')}<select value={form.kind} onChange={event => setForm(current => ({ ...current, kind: event.target.value }))}><option value="ical_url">{t('calendar.icsWebcal')}</option><option value="caldav">{t('calendar.caldav')}</option></select></label>
        <label>{t('calendar.sourceName')}<input required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label>
        <label>{t('calendar.sourceUrl')}<input required type="url" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} /></label>
        {form.kind === 'caldav' && <><label>{t('calendar.sourceUsername')}<input required value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} /></label><label>{t('calendar.sourcePassword')}<input required type="password" autoComplete="new-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label></>}
        <button type="submit" style={primaryButton}>{t('calendar.addSource')}</button>
      </form>
      <div style={sourceList}>{sources.map(source => <div key={source.id} style={sourceRow}><span><strong>{source.displayName}</strong><small>{source.kind} · {source.lastError || t('calendar.sourceReady')}</small></span><span><button onClick={() => syncSource(source.id)} style={linkButton}>{t('calendar.syncSource')}</button><button onClick={() => removeSource(source.id)} style={dangerButton}>{t('calendar.delete')}</button></span></div>)}</div>
    </div></div>}
  </aside>;
}

const panel = { width: 250, flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', overflow: 'auto' }; const closeRow = { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 };
const miniMonth = { display: 'grid', gap: 8, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' };
const weekdayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 };
const dayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 };
const dayButton = { border: 0, borderRadius: 6, minHeight: 28, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' };
const today = { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 700 }; const muted = { color: 'var(--text-tertiary)' };
const section = { display: 'grid', gap: 8, paddingTop: 16 }; const sectionHeading = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 13 };
const calendarToggle = { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer' }; const colorDot = { width: 10, height: 10, borderRadius: '50%' }; const readOnly = { marginLeft: 'auto', color: 'var(--text-tertiary)' };
const linkButton = { border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 4, fontWeight: 650 }; const dangerButton = { ...linkButton, color: 'var(--red)' }; const primaryButton = { border: 0, borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-text)', padding: '8px 10px', cursor: 'pointer', fontWeight: 650 };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 16, background: 'var(--overlay-scrim)' }; const dialog = { width: 520, maxWidth: '100%', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }; const dialogHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }; const formStyle = { display: 'grid', gap: 10 }; const sourceList = { display: 'grid', gap: 8, marginTop: 16 }; const sourceRow = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 8 }; const error = { color: 'var(--red)' };
