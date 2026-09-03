import { useEffect, useMemo, useRef, useState } from 'react';
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

export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn = 1, locale, onSelectDate, onShiftMonth, onToggleCalendar, onSourcesChanged, onCalendarsChanged, onClose, sourcePanelRequest = 0, t }) {
  const [showSources, setShowSources] = useState(false);
  const [sources, setSources] = useState([]);
  const [sourceError, setSourceError] = useState(null);
  const mounted = useRef(false);
  const pendingSourceIds = useRef(new Set());
  const sourcePolls = useRef(new Map());
  const sourceRequestGeneration = useRef(0);
  const [form, setForm] = useState({ kind: 'ical_url', displayName: '', url: '', username: '', password: '', color: '#7c6af7', intervalMin: 60 });
  const [openCalendarMenu, setOpenCalendarMenu] = useState(null);
  const [calendarSaving, setCalendarSaving] = useState(false);
  const cells = useMemo(() => monthCells(anchor, weekStartsOn), [anchor, weekStartsOn]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + ((index + weekStartsOn) % 7)).toLocaleDateString(locale, { weekday: 'short' })), [locale, weekStartsOn]);
  const isVisible = id => visibleCalendarIds == null || visibleCalendarIds.includes(id);
  const clearSourcePoll = id => {
    const timer = sourcePolls.current.get(id);
    if (timer) clearTimeout(timer);
    sourcePolls.current.delete(id);
    pendingSourceIds.current.delete(id);
  };
  useEffect(() => {
    mounted.current = true;
    const polls = sourcePolls.current;
    const pending = pendingSourceIds.current;
    return () => {
      mounted.current = false;
      polls.forEach(timer => clearTimeout(timer));
      polls.clear();
      pending.clear();
    };
  }, []);
  const loadSources = async () => {
    const generation = sourceRequestGeneration.current;
    try {
      const result = await api.calendar.listSources();
      if (!mounted.current || generation !== sourceRequestGeneration.current) return result;
      setSources(result.sources || []); setSourceError(null);
      return result;
    } catch (error) {
      if (!mounted.current || generation !== sourceRequestGeneration.current) return null;
      pendingSourceIds.current.forEach(clearSourcePoll);
      if (mounted.current) setSourceError(error.message);
      return null;
    }
  };
  const waitForInitialSync = sourceId => {
    if (!sourceId || !mounted.current) return;
    clearSourcePoll(sourceId);
    pendingSourceIds.current.add(sourceId);
    let attempts = 0;
    const maxAttempts = 70;
    const poll = async () => {
      if (!mounted.current || !pendingSourceIds.current.has(sourceId)) return;
      const result = await loadSources();
      if (!mounted.current || !pendingSourceIds.current.has(sourceId)) return;
      const source = result?.sources?.find(item => item.id === sourceId);
      if (source?.lastSyncAt || source?.lastError) {
        clearSourcePoll(sourceId);
        await onSourcesChanged();
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        clearSourcePoll(sourceId);
        setSourceError(t('calendar.sourceSyncTimeout', 'Source synchronization timed out.'));
        return;
      }
      sourcePolls.current.set(sourceId, setTimeout(poll, 500));
    };
    poll();
  };
  const openSources = async () => { setShowSources(true); await loadSources(); };
  useEffect(() => {
    if (!sourcePanelRequest) return;
    let active = true;
    setShowSources(true);
    api.calendar.listSources()
      .then(result => {
        if (!active || !mounted.current) return;
        setSources(result.sources || []); setSourceError(null);
      })
      .catch(error => {
        if (!active || !mounted.current) return;
        setSourceError(error.message);
      });
    return () => { active = false; };
  }, [sourcePanelRequest]);
  const addSource = async event => {
    event.preventDefault();
    try {
      const result = await api.calendar.createSource({ ...form, password: form.kind === 'caldav' ? form.password : undefined, username: form.kind === 'caldav' ? form.username : undefined });
      setForm({ kind: 'ical_url', displayName: '', url: '', username: '', password: '', color: '#7c6af7', intervalMin: 60 });
      await loadSources();
      await onSourcesChanged();
      if (result?.sync?.pending) waitForInitialSync(result.source?.id);
    } catch (error) {
      if (error.source) {
        setSources(current => [...current.filter(source => source.id !== error.source.id), error.source]);
        try { await onSourcesChanged(); } catch { /* keep the persisted source visible even if refresh fails */ }
      }
      setSourceError(error.message);
    }
  };
  const removeSource = async id => {
    sourceRequestGeneration.current += 1;
    try { await api.calendar.deleteSource(id); clearSourcePoll(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(error.message); }
  };
  const syncSource = async id => {
    try { await api.calendar.syncSource(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(error.message); }
  };
  const ownedCalendar = calendar => calendar.source === 'local' && !calendar.read_only && calendar.owner_user_id;
  const updateOwnedCalendar = async (calendar, changes) => {
    setCalendarSaving(true); setSourceError(null);
    try {
      await api.calendar.updateCalendar(calendar.id, { name: changes.name || calendar.name, color: changes.color || calendar.color, displayVisible: calendar.display_visible !== false });
      setOpenCalendarMenu(null); await onCalendarsChanged?.();
    } catch (error) { setSourceError(error.message); } finally { setCalendarSaving(false); }
  };
  const renameCalendar = calendar => {
    const name = window.prompt(t('calendar.renamePrompt'), calendar.name);
    if (name && name.trim() && name.trim() !== calendar.name) updateOwnedCalendar(calendar, { name: name.trim() });
  };
  const recolorCalendar = calendar => {
    const color = window.prompt(t('calendar.colorPrompt'), calendar.color || '#7c6af7');
    if (color && /^#[0-9a-f]{6}$/i.test(color)) updateOwnedCalendar(calendar, { color });
    else if (color) setSourceError(t('calendar.invalidColor'));
  };
  const deleteCalendar = async calendar => {
    if (!window.confirm(t('calendar.confirmCalendarDelete', { name: calendar.name }))) return;
    setCalendarSaving(true); setSourceError(null);
    try { await api.calendar.deleteCalendar(calendar.id, calendar.name); setOpenCalendarMenu(null); await onCalendarsChanged?.(); }
    catch (error) { setSourceError(error.message); } finally { setCalendarSaving(false); }
  };
  return <aside data-testid="calendar-sidebar" style={panel} aria-label={t('calendar.panel')}>
    {onClose && <div style={closeRow}><button data-testid="calendar-sidebar-close" aria-label={t('calendar.close')} onClick={onClose} style={linkButton}>{t('calendar.close')}</button></div>}

    <div data-testid="calendar-mini-month" style={miniMonth}>
      <div style={miniMonthHeading}>
        <strong>{anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong>
        <div style={miniMonthNavigation}>
          <button type="button" data-testid="calendar-mini-month-previous" aria-label={t('calendar.previousMonth')} onClick={() => onShiftMonth?.(-1)} style={miniMonthButton}>‹</button>
          <button type="button" data-testid="calendar-mini-month-next" aria-label={t('calendar.nextMonth')} onClick={() => onShiftMonth?.(1)} style={miniMonthButton}>›</button>
        </div>
      </div>
      <div style={weekdayGrid}>{weekdays.map((day, index) => <span data-testid="calendar-mini-weekday" key={index}>{day}</span>)}</div>
      <div style={dayGrid}>{cells.map(day => <button key={day.toISOString()} onClick={() => onSelectDate(day)} style={{ ...dayButton, ...(day.toDateString() === new Date().toDateString() ? today : {}), ...(day.getMonth() !== anchor.getMonth() ? muted : {}) }}>{day.getDate()}</button>)}</div>
    </div>
    <section style={section}>
      <div style={sectionHeading}><strong>{t('calendar.calendars')}</strong><button data-testid="calendar-sidebar-manage-sources" onClick={openSources} style={linkButton}>{t('calendar.manageSources')}</button></div>
      {calendars.map(calendar => <div key={calendar.id} style={calendarRow}><label style={calendarToggle}><input data-testid="calendar-visibility-toggle" type="checkbox" checked={isVisible(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} /><span style={{ ...colorDot, background: calendar.color || 'var(--accent)' }} />{calendar.name}{ownedCalendar(calendar) ? <small style={owned}>{t('calendar.owned')}</small> : <small style={readOnly}>{t('calendar.sourceCalendar')}</small>}</label>{ownedCalendar(calendar) && <div style={menuWrap}><button type="button" aria-label={t('calendar.calendarActions', { name: calendar.name })} aria-expanded={openCalendarMenu === calendar.id} onClick={() => setOpenCalendarMenu(openCalendarMenu === calendar.id ? null : calendar.id)} style={menuButton} disabled={calendarSaving}>⋮</button>{openCalendarMenu === calendar.id && <div role="menu" aria-label={t('calendar.calendarActions', { name: calendar.name })} style={contextMenu}><button role="menuitem" onClick={() => renameCalendar(calendar)}>{t('calendar.rename')}</button><button role="menuitem" onClick={() => recolorCalendar(calendar)}>{t('calendar.changeColor')}</button><button role="menuitem" onClick={() => deleteCalendar(calendar)} style={dangerButton}>{t('calendar.deleteCalendar')}</button></div>}</div>}</div>)}
    </section>
    {showSources && <div role="dialog" aria-modal="true" aria-label={t('calendar.manageSources')} style={overlay}><div style={dialog}>
      <header style={dialogHeader}><h2 style={dialogTitle}>{t('calendar.manageSources')}</h2><button onClick={() => setShowSources(false)} style={linkButton}>{t('calendar.close')}</button></header>
      {sourceError && <p role="alert" style={error}>{sourceError}</p>}
      <form onSubmit={addSource} style={formStyle}>
        <label>{t('calendar.sourceType')}<select value={form.kind} onChange={event => setForm(current => ({ ...current, kind: event.target.value }))}><option value="ical_url">{t('calendar.icsWebcal')}</option><option value="caldav">{t('calendar.caldav')}</option></select></label>
        <label>{t('calendar.sourceName')}<input required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label>
        <label>{t('calendar.sourceUrl')}<input required type="url" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} /></label>
        {form.kind === 'caldav' && <><label>{t('calendar.sourceUsername')}<input required value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} /></label><label>{t('calendar.sourcePassword')}<input required type="password" autoComplete="new-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label></>}
        <button type="submit" style={primaryButton}>{t('calendar.addSource')}</button>
      </form>
      <div style={sourceList}>{sources.map(source => <div key={source.id} data-testid="calendar-source-row" style={sourceRow}><span style={sourceDetails}><strong>{source.displayName}</strong><small>{source.kind === 'caldav' ? t('calendar.caldav') : t('calendar.icsWebcal')} · {pendingSourceIds.current.has(source.id) ? t('calendar.sourceSyncing') : source.lastError || t('calendar.sourceReady')}</small></span><span style={sourceActions}><button onClick={() => syncSource(source.id)} style={linkButton}>{t('calendar.syncSource')}</button><button onClick={() => removeSource(source.id)} style={dangerButton}>{t('calendar.delete')}</button></span></div>)}</div>
    </div></div>}
  </aside>;
}

const panel = { width: 280, boxSizing: 'border-box', flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', overflow: 'auto' }; const closeRow = { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 };
const miniMonth = { display: 'grid', gap: 8, paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)' };
const miniMonthHeading = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }; const miniMonthNavigation = { display: 'flex', gap: 2 }; const miniMonthButton = { minWidth: 28, minHeight: 28, padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 18, fontWeight: 650, lineHeight: 1 };
const weekdayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 };
const dayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 };
const dayButton = { border: 0, borderRadius: 6, minHeight: 28, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' };
const today = { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 700 }; const muted = { color: 'var(--text-tertiary)' };
const section = { display: 'grid', gap: 8, paddingTop: 16 }; const sectionHeading = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 13 };
const calendarRow = { display: 'flex', alignItems: 'center', gap: 4 }; const calendarToggle = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer' }; const colorDot = { width: 10, height: 10, borderRadius: '50%' }; const readOnly = { marginLeft: 'auto', color: 'var(--text-tertiary)' }; const owned = { marginLeft: 'auto', color: 'var(--accent)', fontSize: 11 }; const menuWrap = { position: 'relative' }; const menuButton = { border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, padding: '0 6px' }; const contextMenu = { position: 'absolute', right: 0, top: '100%', zIndex: 3, display: 'grid', minWidth: 150, padding: 4, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', boxShadow: '0 8px 22px rgba(0,0,0,.18)' };
const linkButton = { border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 4, fontWeight: 650 }; const dangerButton = { ...linkButton, color: 'var(--red)' }; const primaryButton = { border: 0, borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-text)', padding: '8px 10px', cursor: 'pointer', fontWeight: 650 };
const overlay = { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 16, background: 'var(--overlay-scrim)' }; const dialog = { width: 'min(520px, 100%)', boxSizing: 'border-box', minWidth: 0, maxHeight: 'calc(100dvh - 32px)', overflow: 'auto', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }; const dialogHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }; const dialogTitle = { margin: 0, minWidth: 0 }; const formStyle = { display: 'grid', gap: 10, minWidth: 0 }; const sourceList = { display: 'grid', gap: 8, marginTop: 16, minWidth: 0 }; const sourceRow = { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: 10, minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 8 }; const sourceDetails = { minWidth: 0, overflowWrap: 'anywhere' }; const sourceActions = { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, minWidth: 0 }; const error = { color: 'var(--red)' };
