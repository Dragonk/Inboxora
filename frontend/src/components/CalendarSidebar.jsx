import { calendarSyncWarning } from '../utils/calendarSyncWarning.js';
import { useBackLayer } from '../hooks/useBackNavigation.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { Button, Dialog } from './ui.jsx';

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

export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn = 1, locale, onSelectDate, onShiftMonth, onToggleCalendar, onSourcesChanged, onCalendarsChanged, onCreate, canCreate, sourcePanelRequest = 0, t }) {
  const [showSources, setShowSources] = useState(false);
  const [sources, setSources] = useState([]);
  const [sourceError, setSourceError] = useState(null);
  const mounted = useRef(false);
  const pendingSourceIds = useRef(new Set());
  const sourcePolls = useRef(new Map());
  const sourceRequestGeneration = useRef(0);
  const [form, setForm] = useState({ kind: 'ical_url', displayName: '', url: '', username: '', password: '', color: '#7c6af7', intervalMin: 60 });
  const [openCalendarMenu, setOpenCalendarMenu] = useState(null);
  const [syncingSourceIds, setSyncingSourceIds] = useState(new Set());
  const [calendarEdit, setCalendarEdit] = useState(null);
  const [editError, setEditError] = useState(null);
  const [calendarSaving, setCalendarSaving] = useState(false);
  useBackLayer(openCalendarMenu, () => { if (!calendarSaving) setOpenCalendarMenu(null); }, 4510);
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
    if (syncingSourceIds.has(id)) return;
    setSyncingSourceIds(current => new Set(current).add(id));
    try { await api.calendar.syncSource(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(error.message); }
    finally { setSyncingSourceIds(current => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const ownedCalendar = calendar => Boolean(calendar.source === 'local' && !calendar.read_only && calendar.owner_user_id);
  const updateCalendarAppearance = async (calendar, changes) => {
    setCalendarSaving(true); setEditError(null);
    try {
      await api.calendar.updateCalendar(calendar.id, { name: changes.name || calendar.name, color: changes.color || calendar.color, displayVisible: calendar.display_visible !== false, customName: Boolean(calendar.custom_name || changes.name !== calendar.name) });
      setOpenCalendarMenu(null); setCalendarEdit(null); await onCalendarsChanged?.();
    } catch (error) { setEditError(error.message); } finally { setCalendarSaving(false); }
  };
  const editCalendar = calendar => {
    setOpenCalendarMenu(null); setEditError(null);
    setCalendarEdit({ calendar, name: calendar.name, color: calendar.color || '#35558a' });
  };
  const deleteCalendar = async calendar => {
    if (!window.confirm(t('calendar.confirmCalendarDelete', { name: calendar.name }))) return;
    setCalendarSaving(true); setSourceError(null);
    try { await api.calendar.deleteCalendar(calendar.id, calendar.name); setOpenCalendarMenu(null); await onCalendarsChanged?.(); }
    catch (error) { setSourceError(error.message); } finally { setCalendarSaving(false); }
  };
  return <aside data-testid="calendar-sidebar" className="calendar-rail" style={panel} aria-label={t('calendar.panel')}>
    <h1 className="calendar-rail-heading">{t('calendar.title')}</h1>
    {onCreate && <Button variant="primary" className="calendar-rail-create" disabled={!canCreate} onClick={onCreate}>+ {t('calendar.newEvent')}</Button>}
    <div data-testid="calendar-mini-month" style={miniMonth}>
      <div style={miniMonthHeading}>
        <strong>{anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong>
        <div style={miniMonthNavigation}>
          <button type="button" data-testid="calendar-mini-month-previous" aria-label={t('calendar.previousMonth')} onClick={() => onShiftMonth?.(-1)} style={miniMonthButton}>‹</button>
          <button type="button" data-testid="calendar-mini-month-next" aria-label={t('calendar.nextMonth')} onClick={() => onShiftMonth?.(1)} style={miniMonthButton}>›</button>
        </div>
      </div>
      <div style={weekdayGrid}>{weekdays.map((day, index) => <span data-testid="calendar-mini-weekday" key={index}>{day}</span>)}</div>
      <div style={dayGrid}>{cells.map(day => <button key={day.toISOString()} aria-pressed={day.toDateString() === anchor.toDateString()} aria-label={day.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })} className={day.toDateString() === anchor.toDateString() ? 'calendar-mini-selected' : undefined} onClick={() => onSelectDate(day)} style={{ ...dayButton, ...(day.toDateString() === new Date().toDateString() ? today : {}), ...(day.getMonth() !== anchor.getMonth() ? muted : {}) }}>{day.getDate()}</button>)}</div>
    </div>
    <section style={section}>
      <div style={sectionHeading}><strong>{t('calendar.calendars')}</strong><button data-testid="calendar-sidebar-manage-sources" onClick={openSources} style={linkButton}>{t('calendar.manageSources')}</button></div>
      {[...calendars].sort((a, b) => Number(a.source !== 'local') - Number(b.source !== 'local')).map((calendar, index, all) => <div key={calendar.id}>{(index === 0 || (all[index - 1].source === 'local') !== (calendar.source === 'local')) && <h2 style={{ ...sectionHeading, margin: '12px 0 4px' }}>{calendar.source === 'local' ? t('calendar.myCalendars') : t('calendar.sourceCalendar')}</h2>}<div key={calendar.id} className="cal-row" style={calendarRow}><label style={calendarToggle}><input data-testid="calendar-visibility-toggle" type="checkbox" checked={isVisible(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} /><span style={{ ...colorDot, background: calendar.color || 'var(--accent)' }} />{calendar.name}{ownedCalendar(calendar) ? <small style={owned}>{t('calendar.owned')}</small> : <small style={readOnly}>{t('calendar.sourceCalendar')}</small>}</label>{<div style={menuWrap}><button type="button" aria-label={t('calendar.calendarActions', { name: calendar.name })} aria-expanded={openCalendarMenu === calendar.id} onClick={() => setOpenCalendarMenu(openCalendarMenu === calendar.id ? null : calendar.id)} style={menuButton} disabled={calendarSaving}>⋮</button>{openCalendarMenu === calendar.id && <div role="menu" aria-label={t('calendar.calendarActions', { name: calendar.name })} style={contextMenu}><button role="menuitem" onClick={() => editCalendar(calendar)}>{t('calendar.rename')}</button><button role="menuitem" onClick={() => editCalendar(calendar)}>{t('calendar.changeColor')}</button>{ownedCalendar(calendar) && <button role="menuitem" onClick={() => deleteCalendar(calendar)} style={dangerButton}>{t('calendar.deleteCalendar')}</button>}</div>}</div>}</div></div>)}
    </section>
    {calendarEdit && <Dialog testId="calendar-appearance-dialog" title={t('calendar.calendarActions', { name: calendarEdit.calendar.name })} closeLabel={t('calendar.close')} busy={calendarSaving} onClose={() => setCalendarEdit(null)} footer={<>
      <Button onClick={() => setCalendarEdit(null)} disabled={calendarSaving}>{t('calendar.cancel')}</Button>
      <Button variant="primary" disabled={calendarSaving || !calendarEdit.name.trim() || !/^#[0-9a-f]{6}$/i.test(calendarEdit.color)} onClick={() => updateCalendarAppearance(calendarEdit.calendar, { name: calendarEdit.name.trim(), color: calendarEdit.color })}>{t(calendarSaving ? 'calendar.saving' : 'calendar.save')}</Button>
    </>}>
      <div className="ui-form">
        {editError && <p role="alert" className="ui-alert">{editError}</p>}
        <label>{t('calendar.renamePrompt')}<input maxLength={120} value={calendarEdit.name} onChange={event => setCalendarEdit(current => ({ ...current, name: event.target.value }))} /></label>
        <label>{t('calendar.changeColor')}<input type="color" style={{ height: 44, padding: 4, boxSizing: 'border-box' }} value={calendarEdit.color} onChange={event => setCalendarEdit(current => ({ ...current, color: event.target.value }))} /></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {['#35558a', '#35793a', '#e879f9', '#e05252', '#d79a28', '#7c6af7'].map(color => <button key={color} type="button" aria-label={`${t('calendar.changeColor')} ${color}`} aria-pressed={calendarEdit.color === color} onClick={() => setCalendarEdit(current => ({ ...current, color }))} style={{ width: 44, height: 44, borderRadius: 8, border: calendarEdit.color === color ? '3px solid var(--text-primary)' : '3px solid transparent', background: color }} />)}
        </div>
      </div>
    </Dialog>}
    {showSources && <Dialog title={t('calendar.manageSources')} closeLabel={t('calendar.close')} onClose={() => setShowSources(false)}>
      {sourceError && <p role="alert" style={error}>{sourceError}</p>}
      <form onSubmit={addSource} className="ui-form" style={formStyle}>
        <label>{t('calendar.sourceType')}<select value={form.kind} onChange={event => setForm(current => ({ ...current, kind: event.target.value }))}><option value="ical_url">{t('calendar.icsWebcal')}</option><option value="caldav">{t('calendar.caldav')}</option></select></label>
        <label>{t('calendar.sourceName')}<input required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label>
        <label>{t('calendar.sourceUrl')}<input required type="url" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} /></label>
        {form.kind === 'caldav' && <><label>{t('calendar.sourceUsername')}<input required value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} /></label><label>{t('calendar.sourcePassword')}<input required type="password" autoComplete="new-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label></>}
        <button type="submit" style={primaryButton}>{t('calendar.addSource')}</button>
      </form>
      <div style={sourceList}>{sources.map(source => <div key={source.id} data-testid="calendar-source-row" style={sourceRow}><span style={sourceDetails}><strong>{source.displayName}</strong><small style={{ display: 'block' }}>{source.kind === 'caldav' ? t('calendar.caldav') : t('calendar.icsWebcal')}</small><SourceStatus source={source} pending={pendingSourceIds.current.has(source.id) || syncingSourceIds.has(source.id)} t={t} /></span><span style={sourceActions}><button disabled={syncingSourceIds.has(source.id) || pendingSourceIds.current.has(source.id)} onClick={() => syncSource(source.id)} style={linkButton}>{t('calendar.syncSource')}</button><button onClick={() => removeSource(source.id)} style={dangerButton}>{t('calendar.delete')}</button></span></div>)}</div>
    </Dialog>}
  </aside>;
}

function SourceStatus({ source, pending, t }) {
  const warning = calendarSyncWarning(source.lastError);
  if (pending) return <small>{t('calendar.sourceSyncing')}</small>;
  if (!warning) return <small>{t('calendar.sourceReady')}</small>;
  return <div><small role="status">{warning.count ? t('calendar.syncSkipped', { count: warning.count }) : t('calendar.syncFailed')}</small>
    <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>{t('calendar.syncDetails')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 140, overflow: 'auto', fontSize: 11 }}>{warning.details}</pre></details>
  </div>;
}

const panel = { boxSizing: 'border-box', flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', overflow: 'auto' };
const miniMonth = { display: 'grid', gap: 2, padding: 8, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8 };
const miniMonthHeading = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, fontWeight: 600, padding: '2px 4px 6px' }; const miniMonthNavigation = { display: 'flex', gap: 2 }; const miniMonthButton = { minWidth: 28, minHeight: 28, padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 18, fontWeight: 650, lineHeight: 1 };
const weekdayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, padding: '3px 0' };
const dayGrid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 };
const dayButton = { width: 24, height: 22, minHeight: 22, margin: '0 auto', padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const today = { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 600 }; const muted = { opacity: .38 };
const section = { display: 'grid', gap: 4, paddingTop: 10 }; const sectionHeading = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
const calendarRow = { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, fontSize: 12.5, color: 'var(--text-secondary)' }; const calendarToggle = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer' }; const colorDot = { width: 10, height: 10, borderRadius: 3 }; const readOnly = { marginLeft: 'auto', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10 }; const owned = { marginLeft: 'auto', color: 'var(--accent)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10 }; const menuWrap = { position: 'relative' }; const menuButton = { border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, padding: '0 6px' }; const contextMenu = { position: 'absolute', right: 0, top: '100%', zIndex: 3, display: 'grid', minWidth: 150, padding: 4, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', boxShadow: '0 8px 22px rgba(0,0,0,.18)' };
const linkButton = { border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 4, fontWeight: 650 }; const dangerButton = { ...linkButton, color: 'var(--red)' }; const primaryButton = { border: 0, borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-text)', padding: '8px 10px', cursor: 'pointer', fontWeight: 650 };
const formStyle = { display: 'grid', gap: 10, minWidth: 0 }; const sourceList = { display: 'grid', gap: 8, marginTop: 16, minWidth: 0 }; const sourceRow = { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: 10, minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 8 }; const sourceDetails = { minWidth: 0, overflowWrap: 'anywhere' }; const sourceActions = { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, minWidth: 0 }; const error = { color: 'var(--red)' };
