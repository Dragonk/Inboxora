import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { toAppError } from '../utils/errors.ts';
import { Button } from './ui.tsx';
import { calendarSidebarGroups, type CalendarPresentation, type CalendarRow } from './calendarSettingsModel.ts';
export { calendarSidebarGroups } from './calendarSettingsModel.ts';

interface CalendarSidebarProps {
  anchor: Date; calendars: CalendarRow[]; visibleCalendarIds: string[] | null;
  weekStartsOn?: number; locale: string; onSelectDate: (date: Date) => void;
  onShiftMonth: (delta: number) => void; onToggleCalendar: (id: string) => void;
  onSourcesChanged: () => void; onCalendarsChanged: () => void;
  onCreate: () => void; canCreate: boolean; sourcePanelRequest?: number; t: TFunction;
}
function openCalendarAccounts() {
  const state = useStore.getState();
  state.setAdminTab('calendar');
  state.setShowAdmin(true);
}

/** The rail owns event selection only. All management lives in Settings → Calendar. */
export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn = 1, locale, onSelectDate, onShiftMonth, onToggleCalendar, onCreate, canCreate, sourcePanelRequest = 0, t }: CalendarSidebarProps) {
  const authEpoch = useStore(state => state.authEpoch);
  const [presentation, setPresentation] = useState<CalendarPresentation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useLayoutEffect(() => {
    let active = true;
    const requestCounter = generation;
    const load = async () => {
      const request = ++generation.current;
      try {
        const result = await api.calendar.presentation() as CalendarPresentation;
        if (active && request === generation.current && useStore.getState().authEpoch === authEpoch) { setPresentation(result); setError(null); }
      } catch (caught) {
        if (active && request === generation.current && useStore.getState().authEpoch === authEpoch) setError(toAppError(caught).message);
      }
    };
    setPresentation(null);
    void load();
    window.addEventListener('inboxora:calendar-changed', load);
    return () => { active = false; requestCounter.current++; window.removeEventListener('inboxora:calendar-changed', load); };
  }, [authEpoch, calendars]);
  useEffect(() => { if (sourcePanelRequest) openCalendarAccounts(); }, [sourcePanelRequest]);
  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    first.setDate(first.getDate() - (first.getDay() - weekStartsOn + 7) % 7);
    return Array.from({ length: 42 }, (_, index) => { const date = new Date(first); date.setDate(first.getDate() + index); return date; });
  }, [anchor, weekStartsOn]);
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + ((index + weekStartsOn) % 7)).toLocaleDateString(locale, { weekday: 'short' }));
  const groups = calendarSidebarGroups(presentation, calendars);
  const collapse = async (id: string, collapsed: boolean) => {
    if (useStore.getState().authEpoch !== authEpoch) return;
    const request = ++generation.current;
    try {
      await api.calendar.updateSourcePresentation(id, collapsed);
      if (request !== generation.current || useStore.getState().authEpoch !== authEpoch) return;
      const result = await api.calendar.presentation() as CalendarPresentation;
      if (request === generation.current && useStore.getState().authEpoch === authEpoch) setPresentation(result);
    } catch (caught) { if (request === generation.current && useStore.getState().authEpoch === authEpoch) setError(toAppError(caught).message); }
  };
  return <aside data-testid="calendar-sidebar" className="calendar-rail" aria-label={t('calendar.panel')} style={{ boxSizing: 'border-box', flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', overflow: 'auto' }}>
    <h1 className="calendar-rail-heading">{t('calendar.title')}</h1>
    <Button variant="primary" className="calendar-rail-create" data-testid="calendar-rail-new-event" disabled={!canCreate} onClick={onCreate}>+ {t('calendar.newEvent')}</Button>
    <div data-testid="calendar-mini-month" style={{ display: 'grid', gap: 2, padding: 8, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
        <strong>{anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong>
        <div><button type="button" data-testid="calendar-mini-month-previous" aria-label={t('calendar.previousMonth')} onClick={() => onShiftMonth(-1)} className="calendar-mini-nav">‹</button><button type="button" data-testid="calendar-mini-month-next" aria-label={t('calendar.nextMonth')} onClick={() => onShiftMonth(1)} className="calendar-mini-nav">›</button></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', fontSize: 10 }}>{weekdays.map((day, index) => <span data-testid="calendar-mini-weekday" key={index}>{day}</span>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>{cells.map(day => <button key={day.toISOString()} aria-pressed={day.toDateString() === anchor.toDateString()} aria-label={day.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })} className={`calendar-mini-day${day.toDateString() === anchor.toDateString() ? ' calendar-mini-selected' : ''}`} onClick={() => onSelectDate(day)} style={{ margin: '0 auto', padding: 0, border: 0, borderRadius: 5, background: day.toDateString() === new Date().toDateString() ? 'var(--accent)' : 'transparent', color: 'var(--text-secondary)', opacity: day.getMonth() === anchor.getMonth() ? 1 : .38 }}>{day.getDate()}</button>)}</div>
    </div>
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><strong>{t('calendar.calendars')}</strong><Button data-testid="calendar-sidebar-manage-sources" onClick={openCalendarAccounts}>{t('calendar.manageSources')}</Button></div>
      {error && <p role="status" data-testid="calendar-presentation-error">{error}</p>}
      {groups.map((group, index) => <div key={group.id} data-testid="calendar-source-group">
        {(index === 0 || groups[index - 1]?.category !== group.category) && <div data-testid="calendar-source-category" style={{ marginTop: 14, fontSize: 12 }}><strong>{t(`calendar.sourceCategory${group.category[0].toUpperCase()}${group.category.slice(1)}`)}</strong></div>}
        <div data-testid="calendar-source-heading" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '10px 0 4px' }}>
          <button type="button" data-testid="calendar-source-collapse" aria-label={group.collapsed ? t('calendar.show', 'Expand source') : t('calendar.hide', 'Collapse source')} aria-expanded={!group.collapsed} onClick={() => collapse(group.id, !group.collapsed)}>{group.collapsed ? '›' : '⌄'}</button>
          <span style={{ display: 'grid', minWidth: 0, fontSize: 12 }}><strong>{group.label}</strong>{group.identityLabel && <small title={group.identityLabel} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.identityLabel}</small>}</span>
        </div>
        {!group.collapsed && group.rows.filter(({ view }) => !view.sidebarHidden).map(({ calendar }) => <label key={calendar.id} className="cal-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12 }}>
          <input data-testid="calendar-visibility-toggle" type="checkbox" checked={visibleCalendarIds == null || visibleCalendarIds.includes(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} />
          <span style={{ width: 10, height: 10, borderRadius: 3, background: calendar.color || 'var(--accent)' }} />{calendar.name}
        </label>)}
      </div>)}
    </section>
  </aside>;
}
