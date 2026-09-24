import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { Button } from './ui.tsx';
import { calendarSidebarGroups, type CalendarPresentation, type CalendarRow } from './calendarSettingsModel.ts';
import { Check, IconButton, Notice } from './accountUi/AccountUi.tsx';
import { ResourceTree, type TreeGroup } from './accountUi/ResourceTree.tsx';
import CalendarColorPalette from './accountUi/CalendarColorPalette.tsx';
import { groupState, sourceLabel } from './accountUi/model.ts';
import { openSettings } from './accountUi/navigation.ts';
import { useCalendarColorPreview } from './accountUi/calendarPreview.ts';
export { calendarSidebarGroups } from './calendarSettingsModel.ts';

interface CalendarSidebarProps {
  anchor: Date; calendars: CalendarRow[]; visibleCalendarIds: string[] | null;
  weekStartsOn?: number; locale: string; onSelectDate: (date: Date) => void;
  onShiftMonth: (delta: number) => void; onToggleCalendar: (id: string) => void;
  onSetCalendarVisibility?: (ids: string[]) => void;
  onSourcesChanged: () => void; onCalendarsChanged: () => void;
  onCreate: () => void; canCreate: boolean; sourcePanelRequest?: number; t: TFunction;
}
export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn = 1, locale, onSelectDate, onShiftMonth, onSetCalendarVisibility, onCreate, canCreate, sourcePanelRequest = 0, t }: CalendarSidebarProps) {
  const epoch = useStore(state => state.authEpoch); const accounts = useStore(state => state.accounts);
  const [presentation, setPresentation] = useState<CalendarPresentation | null>(null);
  const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState<{ id: string; sourceId: string; anchor: HTMLElement; context: string } | null>(null);
  const generation = useRef(0); const collapseLock = useRef(false); const live = useRef(false);
  const colors = useCalendarColorPreview();
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api.calendar.presentation() as CalendarPresentation;
      if (live.current && request === generation.current && useStore.getState().authEpoch === epoch) { setPresentation(result); setFailed(false); }
    } catch { if (live.current && request === generation.current && useStore.getState().authEpoch === epoch) setFailed(true); }
  }, [epoch]);
  useEffect(() => {
    live.current = true; setPresentation(null); setPalette(null); setBusy(false); collapseLock.current = false;
    void load(); const changed = () => { void load(); }; const cancel = () => { live.current = false; generation.current++; };
    window.addEventListener('inboxora:calendar-changed', changed);
    return () => { cancel(); window.removeEventListener('inboxora:calendar-changed', changed); };
  }, [load]);
  useEffect(() => { if (sourcePanelRequest) openSettings({ module: 'calendar', section: 'resources' }); }, [sourcePanelRequest]);
  const collapse = async (id: string, collapsed: boolean) => {
    if (collapseLock.current || useStore.getState().authEpoch !== epoch) return;
    collapseLock.current = true; setBusy(true); setFailed(false);
    try { await api.calendar.updateSourcePresentation(id, collapsed); if (live.current && useStore.getState().authEpoch === epoch) await load(); }
    catch { if (live.current && useStore.getState().authEpoch === epoch) setFailed(true); }
    finally { if (live.current && useStore.getState().authEpoch === epoch) { collapseLock.current = false; setBusy(false); } }
  };
  const groups = calendarSidebarGroups(presentation, calendars);
  const tree: TreeGroup[] = groups.map(group => ({ id: group.id, kind: group.kind, label: sourceLabel(group, t, accounts), identity: group.identityLabel, collapsed: group.collapsed,
    resources: group.rows.filter(({ view }) => !view.sidebarHidden).map(({ calendar }) => ({ id: calendar.id,
      name: calendar.id === 'contacts-birthdays' && !calendar.custom_name ? t('accountUi.contactDates') : calendar.name || t('accountUi.unnamed'),
      readOnly: calendar.read_only === true, color: colors[calendar.id] ?? calendar.color })) }));
  const selected = visibleCalendarIds ?? groups.flatMap(group => group.rows.filter(({ view }) => view.selected && !view.sidebarHidden).map(({ calendar }) => calendar.id));
  const setSelection = (ids: string[]) => {
    if (useStore.getState().authEpoch !== epoch) return;
    // Single array write also supports the existing Zustand setter (not a React updater).
    if (onSetCalendarVisibility) onSetCalendarVisibility(ids);
    else useStore.getState().setVisibleCalendarIds(ids);
  };
  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    first.setDate(first.getDate() - (first.getDay() - weekStartsOn + 7) % 7);
    return Array.from({ length: 42 }, (_, i) => { const day = new Date(first); day.setDate(first.getDate() + i); return day; });
  }, [anchor, weekStartsOn]);
  const weekdays = cells.slice(0, 7).map(day => day.toLocaleDateString(locale, { weekday: 'short' }));
  const allIds = tree.flatMap(group => group.resources.map(resource => resource.id));
  const allState = groupState(allIds, selected);
  const allCollapsed = tree.length > 0 && tree.every(group => group.collapsed);
  const collapseAll = async () => {
    if (collapseLock.current || useStore.getState().authEpoch !== epoch) return;
    collapseLock.current = true; setBusy(true);
    try { await Promise.all(tree.map(group => api.calendar.updateSourcePresentation(group.id, !allCollapsed))); if (live.current && useStore.getState().authEpoch === epoch) await load(); }
    catch { if (live.current && useStore.getState().authEpoch === epoch) setFailed(true); }
    finally { if (live.current && useStore.getState().authEpoch === epoch) { collapseLock.current = false; setBusy(false); } }
  };
  const calendar = palette ? calendars.find(item => item.id === palette.id) : undefined;
  return <aside data-testid="calendar-sidebar" className="calendar-rail au-workspace" aria-label={t('calendar.panel')} style={{ boxSizing: 'border-box', flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', overflow: 'auto' }}>
    <h1 className="calendar-rail-heading">{t('calendar.title')}</h1>
    <Button variant="primary" className="calendar-rail-create" data-testid="calendar-rail-new-event" disabled={!canCreate} onClick={onCreate}>+ {t('calendar.newEvent')}</Button>
    <div data-testid="calendar-mini-month" style={{ display: 'grid', gap: 2, padding: 8, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}><strong>{anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong><div style={{ display: 'flex' }}><IconButton icon="back" label={t('calendar.previousMonth')} onClick={() => onShiftMonth(-1)}/><IconButton icon="chevron" label={t('calendar.nextMonth')} onClick={() => onShiftMonth(1)}/></div></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', textAlign: 'center', fontSize: 10 }}>{weekdays.map((day, i) => <span key={i}>{day}</span>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1 }}>{cells.map(day => <button type="button" key={day.toDateString()} aria-pressed={day.toDateString() === anchor.toDateString()} aria-label={day.toLocaleDateString(locale, { dateStyle: 'full' })} className={`calendar-mini-day${day.toDateString() === anchor.toDateString() ? ' calendar-mini-selected' : ''}`} onClick={() => onSelectDate(day)} style={{ margin: '0 auto', padding: 0, border: 0, borderRadius: 5, background: day.toDateString() === new Date().toDateString() ? 'var(--accent)' : 'transparent', color: day.toDateString() === new Date().toDateString() ? 'var(--accent-text)' : 'var(--text-secondary)', opacity: day.getMonth() === anchor.getMonth() ? 1 : .38 }}>{day.getDate()}</button>)}</div>
    </div>
    <div className="au-tree-toolbar"><strong>{t('accountUi.displayedCalendars')}</strong><IconButton icon="settings" label={t('accountUi.manageCalendars')} data-testid="calendar-sidebar-manage-sources" onClick={() => openSettings({ module: 'calendar', section: 'accounts' })}/></div>
    {failed && <Notice danger>{t('accountUi.operationFailed')} <Button onClick={() => void load()}>{t('accountUi.retry')}</Button></Notice>}
    {!presentation && !failed && <p className="au-note">{t('common.loading')}</p>}
    <div className="au-select-all"><label><Check aria-label={t('accountUi.allCalendars')} checked={allState.checked} mixed={allState.mixed} disabled={!allState.total} onChange={() => setSelection(allState.checked ? [] : allIds)}/><span>{t('accountUi.selectedOf', { selected: allState.count, total: allState.total })}</span></label><button type="button" onClick={() => setSelection(allIds)}>{t('accountUi.showAll')}</button><IconButton icon={allCollapsed ? 'down' : 'chevron'} label={t(allCollapsed ? 'accountUi.expandAll' : 'accountUi.collapseAll')} disabled={busy || !tree.length} onClick={() => void collapseAll()}/></div>
    <ResourceTree groups={tree} selected={selected} disabled={busy} onChange={setSelection} onCollapse={(id, collapsed) => void collapse(id, collapsed)}
      onManage={(sourceId, resourceId) => openSettings({ module: 'calendar', section: resourceId || sourceId === 'local' ? 'resources' : 'accounts', sourceId, resourceId })}
      onColor={(resource, sourceId, element) => setPalette({ id: resource.id, sourceId, anchor: element, context: tree.find(group => group.id === sourceId)?.label ?? '' })}/>
    {palette && calendar && <CalendarColorPalette key={calendar.id} calendar={calendar} sourceId={palette.sourceId} context={palette.context} anchor={palette.anchor} onClose={() => setPalette(null)}/>}
  </aside>;
}
