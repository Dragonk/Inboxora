import { calendarSyncWarning } from '../utils/calendarSyncWarning.ts';
import { useBackLayer } from '../hooks/useBackNavigation.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api.ts';
import { Button, Dialog } from './ui.tsx';
import type { CSSProperties, FormEvent } from 'react';
import { toAppError } from '../utils/errors.ts';
import { summariseProviderSyncErrors } from '../utils/providerSyncError.ts';
import type { TFunction } from 'i18next';

/** A calendar source as GET /calendar/sources returns it. */
interface CalendarSource {
  id: string;
  displayName?: string;
  kind?: string;
  intervalMin?: number;
  lastError?: string | null;
  lastSyncAt?: string | null;
  [key: string]: unknown;
}

/** Response of GET /calendar/sources. */
interface CalendarSourceList {
  sources?: CalendarSource[];
}

interface CalendarPresentationSource {
  id: string;
  kind: string;
  label: string;
  accountId: string | null;
  identityLabel: string | null;
  featureEnabled: boolean;
  canSync: boolean;
  collapsed: boolean;
}
interface CalendarPresentationCalendar { id: string; sourceId: string; displayName: string; readOnly: boolean; selected: boolean; sidebarHidden: boolean }
interface CalendarPresentation {
  revision?: string;
  sources?: CalendarPresentationSource[];
  calendars?: CalendarPresentationCalendar[];
  groups?: Array<CalendarPresentationSource & { calendars: CalendarPresentationCalendar[] }>;
}

/** Joins server-owned group identities to the current calendar rows without naming heuristics. */
export function calendarSidebarGroups(presentation: CalendarPresentation | null, calendars: CalendarRow[]) {
  return (presentation?.groups ?? []).map(group => ({
    ...group,
    rows: group.calendars.map(view => ({ view, calendar: calendars.find(calendar => calendar.id === view.id) })).filter((item): item is { view: CalendarPresentationCalendar; calendar: CalendarRow } => item.calendar !== undefined),
  }));
}

/** One account's outcome from POST /accounts/:id/provider-features/calendars/sync. */
interface ProviderCalendarSyncOutcome {
  collections?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  skipped?: number;
  errors?: Array<{ calendarId?: string; code?: string; message?: string; providerStatus?: number | null; missingScopes?: string[] | null }>;
  error?: { code?: string; message?: string; providerStatus?: number | null; missingScopes?: string[] | null };
}

/** A calendar row as the sidebar receives it (local rows carry ownership fields). */
interface CalendarRow {
  id: string;
  name?: string | null;
  color?: string | null;
  source?: string | null;
  read_only?: boolean | null;
  owner_user_id?: string | null;
  display_visible?: boolean | null;
  custom_name?: boolean | null;
  dav_mode?: string | null;
  /** The provider collection this calendar was pulled into; absent for a local calendar. */
  collection_id?: string | null;
  [key: string]: unknown;
}

/** The DAV modes the collection editor can choose. */
type DavMode = 'off' | 'read_only' | 'read_write';

function davModeOf(value: unknown): DavMode {
  return value === 'off' || value === 'read_only' || value === 'read_write' ? value : 'read_write';
}

/** The appearance dialog's draft: the calendar plus its editable field values. */
interface CalendarEditDraft {
  calendar: CalendarRow;
  name: string;
  color: string;
  davMode: DavMode;
}

/** Whether a value carries the id an external calendar source always has. */
function isCalendarSource(value: unknown): value is CalendarSource {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}

/** The source attached to a failed createSource response, when it has one. */
function failedCalendarSource(error: unknown): CalendarSource | null {
  if (typeof error !== 'object' || error === null || !('source' in error)) return null;
  return isCalendarSource(error.source) ? error.source : null;
}

function monthCells(anchor: Date, weekStartsOn: number): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  first.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    return date;
  });
}

/** The calendar rail: mini month, source panel and calendar toggles. */
interface CalendarSidebarProps {
  anchor: Date;
  calendars: CalendarRow[];
  visibleCalendarIds: string[] | null;
  weekStartsOn?: number;
  locale: string;
  onSelectDate: (date: Date) => void;
  onShiftMonth: (delta: number) => void;
  onToggleCalendar: (id: string) => void;
  onSourcesChanged: () => void;
  onCalendarsChanged: () => void;
  onCreate: () => void;
  canCreate: boolean;
  sourcePanelRequest?: number;
  t: TFunction;
}

export default function CalendarSidebar({ anchor, calendars, visibleCalendarIds, weekStartsOn = 1, locale, onSelectDate, onShiftMonth, onToggleCalendar, onSourcesChanged, onCalendarsChanged, onCreate, canCreate, sourcePanelRequest = 0, t }: CalendarSidebarProps) {
  const [showSources, setShowSources] = useState(false);
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pendingSourceIds = useRef(new Set<string>());
  const sourcePolls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sourceRequestGeneration = useRef(0);
  // Credential-bearing CalDAV connections are created in Calendar settings.
  // This manager adds and manages non-authenticated ICS/webcal sources only.
  const [form, setForm] = useState({ displayName: '', url: '', color: '#7c6af7', intervalMin: 60 });
  const [openCalendarMenu, setOpenCalendarMenu] = useState<string | null>(null);
  const [syncingSourceIds, setSyncingSourceIds] = useState<Set<string>>(new Set());
  const [calendarEdit, setCalendarEdit] = useState<CalendarEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [calendarSaving, setCalendarSaving] = useState(false);
  // The server's durable group model controls the rail from its first render.
  const [presentation, setPresentation] = useState<CalendarPresentation | null>(null);
  // Keep a failed optional presentation snapshot separate from source management.
  // A source-list error must not be replaced by an unrelated failed sidebar refresh.
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const presentationRequestGeneration = useRef(0);
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(new Set());
  const [accountSyncNotices, setAccountSyncNotices] = useState<Map<string, string>>(new Map());
  // Hide is a presentation action, not a selection mutation. This records only the
  // temporary event suppression needed while hidden so restore returns the prior choice.
  const selectedBeforeHide = useRef(new Map<string, boolean>());
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [managerSearch, setManagerSearch] = useState('');
  const [icsImporting, setIcsImporting] = useState(false);
  // What the last .ics import added, so the result is visible instead of the dialog
  // simply closing.
  const [importNotice, setImportNotice] = useState('');
  const importIcsRef = useRef<HTMLInputElement | null>(null);
  useBackLayer(openCalendarMenu, () => { if (!calendarSaving) setOpenCalendarMenu(null); }, 4510);
  const cells = useMemo(() => monthCells(anchor, weekStartsOn), [anchor, weekStartsOn]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + ((index + weekStartsOn) % 7)).toLocaleDateString(locale, { weekday: 'short' })), [locale, weekStartsOn]);
  const isVisible = (id: string) => visibleCalendarIds == null || visibleCalendarIds.includes(id);
  const clearSourcePoll = (id: string) => {
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
  const loadSources = async (): Promise<CalendarSourceList | null> => {
    const generation = sourceRequestGeneration.current;
    try {
      const result: CalendarSourceList = await api.calendar.listSources();
      if (!mounted.current || generation !== sourceRequestGeneration.current) return result;
      setSources(result.sources || []); setSourceError(null);
      return result;
    } catch (error) {
      if (!mounted.current || generation !== sourceRequestGeneration.current) return null;
      pendingSourceIds.current.forEach(clearSourcePoll);
      if (mounted.current) setSourceError(toAppError(error).message);
      return null;
    }
  };
  const waitForInitialSync = (sourceId: string) => {
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
  const loadPresentation = async () => {
    const generation = ++presentationRequestGeneration.current;
    try {
      const result = await api.calendar.presentation() as CalendarPresentation;
      if (mounted.current && generation === presentationRequestGeneration.current) {
        setPresentation(result); setPresentationError(null);
      }
      return result;
    } catch (caught) {
      if (mounted.current && generation === presentationRequestGeneration.current) setPresentationError(toAppError(caught).message);
      return null;
    }
  };
  // The durable presentation is the sidebar's source of truth from first entry;
  // request generations fence responses from an older session/view refresh.
  useEffect(() => { void loadPresentation(); }, []);
  const openSources = async () => {
    setShowSources(true); setShowAddSource(false);
    const [, snapshot] = await Promise.all([loadSources(), loadPresentation()]);
    if (snapshot?.sources?.length) setSelectedSourceId(current => current && snapshot.sources!.some(source => source.id === current) ? current : snapshot.sources![0].id);
  };
  useEffect(() => {
    if (!sourcePanelRequest) return;
    let active = true;
    const presentationGeneration = ++presentationRequestGeneration.current;
    setShowSources(true);
    Promise.all([api.calendar.listSources(), api.calendar.presentation()])
      .then(([sourceResult, presentationResult]) => {
        if (!active || !mounted.current || presentationGeneration !== presentationRequestGeneration.current) return;
        setSources(sourceResult.sources || []); setPresentation(presentationResult as CalendarPresentation); setSourceError(null);
      })
      .catch(error => { if (active && mounted.current) setSourceError(toAppError(error).message); });
    return () => { active = false; };
  }, [sourcePanelRequest]);
  const addSource = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await api.calendar.createSource({ kind: 'ical_url', ...form });
      setForm({ displayName: '', url: '', color: '#7c6af7', intervalMin: 60 });
      await loadSources();
      await onSourcesChanged();
      if (result?.sync?.pending) waitForInitialSync(result.source?.id);
    } catch (error) {
      const failedSource = failedCalendarSource(error);
      if (failedSource) {
        setSources(current => [...current.filter(source => source.id !== failedSource.id), failedSource]);
        try { await onSourcesChanged(); } catch { /* keep the persisted source visible even if refresh fails */ }
      }
      setSourceError(toAppError(error).message);
    }
  };
  const runAccountCalendarSync = async (source: CalendarPresentationSource) => {
    if (!source.accountId || syncingAccountIds.has(source.accountId)) return;
    setSyncingAccountIds(current => new Set(current).add(source.accountId!));
    setAccountSyncNotices(current => { const next = new Map(current); next.delete(source.accountId!); return next; });
    setSourceError(null);
    try {
      const response = await api.syncAccountProviderFeature(source.accountId, 'calendars') as { state?: string; result?: ProviderCalendarSyncOutcome };
      const outcome = response.result ?? {};
      const failed = (outcome.error ? 1 : 0) + (outcome.errors?.length ?? 0);
      const values = { calendars: outcome.collections ?? 0, created: outcome.created ?? 0, updated: outcome.updated ?? 0, deleted: outcome.deleted ?? 0, failed };
      const failureSummary = summariseProviderSyncErrors({ t, provider: source.kind === 'microsoft' ? 'microsoft' : 'google', feature: 'calendar', errors: [outcome.error, ...(outcome.errors ?? [])] });
      const partial = response.state !== 'success' || failed > 0;
      const notice = partial
        ? `${t('calendar.providerSyncPartial', { provider: source.label, ...values })} ${failureSummary?.first ?? ''}`.trim()
        : t('calendar.providerSyncDone', { provider: source.label, ...values });
      setAccountSyncNotices(current => new Map(current).set(source.accountId!, notice));
      await Promise.all([loadPresentation(), onSourcesChanged()]);
    } catch (caught) { setSourceError(toAppError(caught).message); }
    finally { if (mounted.current) setSyncingAccountIds(current => { const next = new Set(current); next.delete(source.accountId!); return next; }); }
  };
  const importIcsFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const calendar = calendarEdit?.calendar;
    event.target.value = '';
    if (!file || !calendar) return;
    setIcsImporting(true);
    setEditError(null);
    try {
      const result = await api.calendar.importIcs(calendar.id, await file.text()) as { imported?: number; protected?: number };
      // The dialog stays open: the confirmation is the point, and another file may follow.
      // Events left alone because Inboxora sent their invitations are reported rather than
      // silently unchanged.
      const imported = result?.imported ?? 0;
      const protectedCount = result?.protected ?? 0;
      setImportNotice(protectedCount
        ? `${t('calendar.importDone', { count: imported })} ${t('calendar.importProtected', { count: protectedCount })}`
        : t('calendar.importDone', { count: imported }));
      await onSourcesChanged();
    } catch (error) {
      setEditError(toAppError(error).message);
    } finally {
      if (mounted.current) setIcsImporting(false);
    }
  };
  const removeSource = async (id: string) => {
    if (!window.confirm(t('calendar.removeSourceConfirm'))) return;
    sourceRequestGeneration.current += 1;
    try { await api.calendar.deleteSource(id); clearSourcePoll(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(toAppError(error).message); }
  };
  const syncSource = async (id: string) => {
    if (syncingSourceIds.has(id)) return;
    setSyncingSourceIds(current => new Set(current).add(id));
    try { await api.calendar.syncSource(id); await loadSources(); await onSourcesChanged(); }
    catch (error) { setSourceError(toAppError(error).message); }
    finally { setSyncingSourceIds(current => { const next = new Set(current); next.delete(id); return next; }); }
  };
  // The cadence is per calendar, so it saves on change rather than behind a save
  // button: one control, one decision. The row already shows the resulting state.
  const changeSourceInterval = async (source: CalendarSource, intervalMin: number) => {
    const previous = source.intervalMin;
    setSources(current => current.map(item => item.id === source.id ? { ...item, intervalMin } : item));
    try { await api.calendar.updateSource(source.id, { intervalMin }); }
    catch (error) {
      // Put the previous value back, so the control never claims a cadence the server
      // did not accept.
      setSources(current => current.map(item => item.id === source.id ? { ...item, intervalMin: previous } : item));
      setSourceError(toAppError(error).message);
    }
  };
  // Provider write-back changes event capability, not collection lifecycle. Generic
  // rename/color/delete remains local-only until a provider-native collection journal exists.
  const localCalendar = (calendar: CalendarRow) => calendar.source === 'local';
  const ownedCalendar = (calendar: CalendarRow) => Boolean(localCalendar(calendar) && !calendar.read_only && calendar.owner_user_id);

  /**
   * Turn write-back on or off for a pulled calendar.
   *
   * The provider is the authority on whether it accepts writes, so the answer — including a refusal —
   * comes from the server and is shown as-is rather than guessed from the calendar's source here.
   */
  const setWriteBack = async (calendar: CalendarRow) => {
    if (!calendar.collection_id) return;
    setCalendarSaving(true);
    try {
      await api.setCollectionWriteBack(calendar.collection_id, Boolean(calendar.read_only));
      setOpenCalendarMenu(null);
      await onCalendarsChanged();
    } catch (caught) {
      setEditError(toAppError(caught).message);
    } finally {
      setCalendarSaving(false);
    }
  };
  const updateCalendarAppearance = async (calendar: CalendarRow, changes: { name?: string; color?: string; davMode?: DavMode }) => {
    setCalendarSaving(true); setEditError(null);
    try {
      await api.calendar.updateCalendar(calendar.id, { name: changes.name || calendar.name, color: changes.color || calendar.color, displayVisible: calendar.display_visible !== false, customName: Boolean(calendar.custom_name || changes.name !== calendar.name), davMode: changes.davMode ?? davModeOf(calendar.dav_mode) });
      setOpenCalendarMenu(null); setCalendarEdit(null); await onCalendarsChanged?.();
    } catch (error) { setEditError(toAppError(error).message); } finally { setCalendarSaving(false); }
  };
  const editCalendar = (calendar: CalendarRow) => {
    setOpenCalendarMenu(null); setEditError(null); setImportNotice('');
    setCalendarEdit({ calendar, name: calendar.name ?? '', color: calendar.color || '#35558a', davMode: davModeOf(calendar.dav_mode) });
  };
  const deleteCalendar = async (calendar: CalendarRow) => {
    if (calendar.name === null || calendar.name === undefined) {
      throw new Error('Cannot delete a calendar without a name');
    }
    if (!window.confirm(t('calendar.confirmCalendarDelete', { name: calendar.name }))) return;
    setCalendarSaving(true); setSourceError(null);
    try { await api.calendar.deleteCalendar(calendar.id, calendar.name); setOpenCalendarMenu(null); await onCalendarsChanged?.(); }
    catch (error) { setSourceError(toAppError(error).message); } finally { setCalendarSaving(false); }
  };
  const presentationCalendar = new Map((presentation?.calendars ?? []).map(item => [item.id, item]));
  const updateCollapsed = async (sourceId: string, collapsed: boolean) => { try { await api.calendar.updateSourcePresentation(sourceId, collapsed); await loadPresentation(); } catch (caught) { setSourceError(toAppError(caught).message); } };
  const updateHidden = async (calendar: CalendarRow, sidebarHidden: boolean) => {
    const priorSelection = isVisible(calendar.id);
    try {
      await api.calendar.updateCalendarPresentation(calendar.id, sidebarHidden);
      if (sidebarHidden) {
        selectedBeforeHide.current.set(calendar.id, priorSelection);
        if (priorSelection) onToggleCalendar(calendar.id);
      } else if (selectedBeforeHide.current.get(calendar.id) === true) {
        // Restoring must recover the selection that existed before hiding, but never
        // select a calendar that was already unchecked.
        onToggleCalendar(calendar.id);
        selectedBeforeHide.current.delete(calendar.id);
      }
      setOpenCalendarMenu(null); await loadPresentation();
    } catch (caught) { setSourceError(toAppError(caught).message); }
  };
  // A successfully persisted external source can be returned before the next
  // presentation snapshot has incorporated it (notably after its first sync
  // fails). Keep that source actionable in the manager rather than making it
  // disappear until a later refresh.
  const presentationSources = presentation?.sources ?? [];
  const transientExternalSources: CalendarPresentationSource[] = sources
    .filter(source => !presentationSources.some(view => view.id === `calendar-source:${source.id}`))
    .map(source => ({ id: `calendar-source:${source.id}`, kind: source.kind ?? 'ical_url', label: source.displayName ?? source.id, accountId: null, identityLabel: null, featureEnabled: true, canSync: true, collapsed: false }));
  const managerSources = [...presentationSources, ...transientExternalSources]
    .filter(source => `${source.label} ${source.identityLabel ?? ''}`.toLocaleLowerCase().includes(managerSearch.toLocaleLowerCase()));
  const managerSource = managerSources.find(source => source.id === selectedSourceId) ?? managerSources[0] ?? null;
  const managerRows = managerSource ? calendarSidebarGroups(presentation, calendars).find(group => group.id === managerSource.id)?.rows ?? [] : [];
  const managedExternalSource = managerSource ? sources.find(source => `calendar-source:${source.id}` === managerSource.id) : undefined;
  return <aside data-testid="calendar-sidebar" className="calendar-rail" style={panel} aria-label={t('calendar.panel')}>
    <h1 className="calendar-rail-heading">{t('calendar.title')}</h1>
    {onCreate && <Button variant="primary" className="calendar-rail-create" data-testid="calendar-rail-new-event" disabled={!canCreate} onClick={onCreate}>+ {t('calendar.newEvent')}</Button>}
    <div data-testid="calendar-mini-month" style={miniMonth}>
      <div style={miniMonthHeading}>
        <strong>{anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong>
        <div style={miniMonthNavigation}>
          <button type="button" data-testid="calendar-mini-month-previous" aria-label={t('calendar.previousMonth')} onClick={() => onShiftMonth?.(-1)} className="calendar-mini-nav" style={miniMonthButton}>‹</button>
          <button type="button" data-testid="calendar-mini-month-next" aria-label={t('calendar.nextMonth')} onClick={() => onShiftMonth?.(1)} className="calendar-mini-nav" style={miniMonthButton}>›</button>
        </div>
      </div>
      <div style={weekdayGrid}>{weekdays.map((day, index) => <span data-testid="calendar-mini-weekday" key={index}>{day}</span>)}</div>
      <div style={dayGrid}>{cells.map(day => <button key={day.toISOString()} aria-pressed={day.toDateString() === anchor.toDateString()} aria-label={day.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })} className={`calendar-mini-day${day.toDateString() === anchor.toDateString() ? ' calendar-mini-selected' : ''}`} onClick={() => onSelectDate(day)} style={{ ...dayButton, ...(day.toDateString() === new Date().toDateString() ? today : {}), ...(day.getMonth() !== anchor.getMonth() ? muted : {}) }}>{day.getDate()}</button>)}</div>
    </div>
    <section style={section}>
      <div style={sectionHeading}><strong>{t('calendar.calendars')}</strong><button data-testid="calendar-sidebar-manage-sources" onClick={openSources} style={linkButton}>{t('calendar.manageSources')}</button></div>
      {presentationError && <p role="status" data-testid="calendar-presentation-error" style={{ margin: '4px 0', fontSize: 12 }}>{presentationError}</p>}
      {calendarSidebarGroups(presentation, calendars).map(group => <div key={group.id} data-testid="calendar-source-group">
        <div data-testid="calendar-source-heading" style={{ ...sourceHeading, margin: '12px 0 4px' }}>
          <button type="button" data-testid="calendar-source-collapse" aria-label={group.collapsed ? t('calendar.show', 'Expand source') : t('calendar.hide', 'Collapse source')} aria-expanded={!group.collapsed} onClick={() => updateCollapsed(group.id, !group.collapsed)} style={chevronButton}>{group.collapsed ? '›' : '⌄'}</button>
          <span style={sourceHeadingText}><strong>{group.label}</strong>{group.identityLabel && <small title={group.identityLabel} style={identityText}>{group.identityLabel}</small>}</span>
          {group.accountId && group.canSync && <button type="button" data-testid="calendar-account-sync" aria-label={syncingAccountIds.has(group.accountId) ? t('calendar.providerSyncing', { provider: group.label }) : t('calendar.providerSync', { provider: group.label })} disabled={syncingAccountIds.has(group.accountId)} onClick={() => runAccountCalendarSync(group)} style={compactAction}>{syncingAccountIds.has(group.accountId) ? '…' : '↻'}</button>}
        </div>
        {group.accountId && accountSyncNotices.get(group.accountId) && <p role="status" data-testid="calendar-account-sync-result" style={{ margin: '0 0 4px', fontSize: 12 }}>{accountSyncNotices.get(group.accountId)}</p>}
        {group.rows.map(({ view, calendar }) => {
          return view.sidebarHidden || group.collapsed ? null : <div key={calendar.id}><div key={calendar.id} className="cal-row" style={calendarRow}><label style={calendarToggle}><input data-testid="calendar-visibility-toggle" type="checkbox" checked={isVisible(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} /><span style={{ ...colorDot, background: calendar.color || 'var(--accent)' }} />{calendar.name}{ownedCalendar(calendar) ? <small style={owned}>{t('calendar.owned')}</small> : <small style={readOnly}>{t('calendar.sourceCalendar')}</small>}</label>{<div style={menuWrap}><button type="button" aria-label={t('calendar.calendarActions', { name: calendar.name })} aria-expanded={openCalendarMenu === calendar.id} onClick={() => setOpenCalendarMenu(openCalendarMenu === calendar.id ? null : calendar.id)} style={menuButton} disabled={calendarSaving}>⋮</button>{openCalendarMenu === calendar.id && <div role="menu" aria-label={t('calendar.calendarActions', { name: calendar.name })} style={contextMenu}>{localCalendar(calendar) && <><button role="menuitem" onClick={() => editCalendar(calendar)}>{t('calendar.rename')}</button><button role="menuitem" onClick={() => editCalendar(calendar)}>{t('calendar.changeColor')}</button></>}<button role="menuitem" data-testid="calendar-hide" onClick={() => updateHidden(calendar, !(presentationCalendar.get(calendar.id)?.sidebarHidden === true))}>{presentationCalendar.get(calendar.id)?.sidebarHidden ? t('calendar.show', 'Show') : t('calendar.hide', 'Hide from list')}</button>{calendar.collection_id && <button role="menuitem" data-testid="calendar-write-back" onClick={() => setWriteBack(calendar)} disabled={calendarSaving}>{calendar.read_only ? t('calendar.enableWriteBack') : t('calendar.disableWriteBack')}</button>}{ownedCalendar(calendar) && <button role="menuitem" onClick={() => deleteCalendar(calendar)} style={dangerButton}>{t('calendar.deleteCalendar')}</button>}</div>}</div>}</div></div>})}</div>)}
      {presentation && presentation.calendars?.some(item => item.sidebarHidden) && <details data-testid="calendar-hidden-calendars"><summary>{t('calendar.hiddenCalendars')}</summary>{presentation.calendars.filter(item => item.sidebarHidden).map(view => <div key={view.id} style={calendarRow}><span>{view.displayName}</span><button type="button" data-testid="calendar-restore-hidden" onClick={() => updateHidden({ id: view.id, name: view.displayName }, false)} style={linkButton}>{t('calendar.restore')}</button></div>)}</details>}
    </section>
    {calendarEdit && <Dialog testId="calendar-appearance-dialog" title={t('calendar.calendarActions', { name: calendarEdit.calendar.name })} closeLabel={t('calendar.close')} busy={calendarSaving} onClose={() => setCalendarEdit(null)} footer={<>
      <Button onClick={() => setCalendarEdit(null)} disabled={calendarSaving}>{t('calendar.cancel')}</Button>
      <Button variant="primary" disabled={calendarSaving || !calendarEdit.name.trim() || !/^#[0-9a-f]{6}$/i.test(calendarEdit.color)} onClick={() => updateCalendarAppearance(calendarEdit.calendar, { name: calendarEdit.name.trim(), color: calendarEdit.color, davMode: calendarEdit.davMode })}>{t(calendarSaving ? 'calendar.saving' : 'calendar.save')}</Button>
    </>}>
      <div className="ui-form">
        {editError && <p role="alert" className="ui-alert">{editError}</p>}
        <label>{t('calendar.renamePrompt')}<input maxLength={120} value={calendarEdit.name} onChange={event => setCalendarEdit(current => current ? { ...current, name: event.target.value } : current)} /></label>
        <label>{t('calendar.changeColor')}<input type="color" style={{ height: 44, padding: 4, boxSizing: 'border-box' }} value={calendarEdit.color} onChange={event => setCalendarEdit(current => current ? { ...current, color: event.target.value } : current)} /></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {['#35558a', '#35793a', '#e879f9', '#e05252', '#d79a28', '#7c6af7'].map(color => <button key={color} type="button" aria-label={`${t('calendar.changeColor')} ${color}`} aria-pressed={calendarEdit.color === color} onClick={() => setCalendarEdit(current => current ? { ...current, color } : current)} style={{ width: 44, height: 44, borderRadius: 8, border: calendarEdit.color === color ? '3px solid var(--text-primary)' : '3px solid transparent', background: color }} />)}
        </div>
        {/* DAV sharing is per collection so a device password can never widen it. */}
        <label>{t('calendar.davAccess')}
          <select data-testid="calendar-dav-mode" value={calendarEdit.davMode} onChange={event => setCalendarEdit(current => current ? { ...current, davMode: davModeOf(event.target.value) } : current)}>
            <option value="off">{t('calendar.davAccessOff')}</option>
            <option value="read_only">{t('calendar.davAccessReadOnly')}</option>
            <option value="read_write">{t('calendar.davAccessReadWrite')}</option>
          </select>
        </label>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>{t('calendar.davAccessHint')}</p>
        {/* An .ics file goes into one local calendar; a provider calendar is written
            by its source, which is why this lives in the appearance dialog. */}
        <button type="button" data-testid="calendar-import-ics" disabled={icsImporting} onClick={() => importIcsRef.current?.click()} style={linkButton}>{icsImporting ? t('calendar.importingIcs') : t('calendar.importIcs')}</button>
        {importNotice && <p role="status" data-testid="calendar-import-result" style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>{importNotice}</p>}
      </div>
    </Dialog>}
    <input ref={importIcsRef} type="file" accept=".ics,text/calendar" onChange={importIcsFile} style={{ display: 'none' }} />
    {showSources && <Dialog title={t('calendar.manageSources')} closeLabel={t('calendar.close')} onClose={() => setShowSources(false)}>
      {sourceError && <p role="alert" style={error}>{sourceError}</p>}
      <div style={managerToolbar}><input data-testid="calendar-source-search" aria-label={t('calendar.searchSources', 'Search sources or calendars')} value={managerSearch} onChange={event => setManagerSearch(event.target.value)} placeholder={t('calendar.searchSources', 'Search sources or calendars')} /><button type="button" data-testid="calendar-add-source" onClick={() => setShowAddSource(current => !current)} style={primaryButton}>{showAddSource ? t('calendar.cancel') : `+ ${t('calendar.addSource')}`}</button></div>
      <div data-testid="calendar-source-manager" style={managerLayout}>
        <nav aria-label={t('calendar.manageSources')} style={managerList}>{managerSources.map(source => <button key={source.id} type="button" data-testid="calendar-manager-source" aria-pressed={managerSource?.id === source.id} onClick={() => { setSelectedSourceId(source.id); setShowAddSource(false); }} style={{ ...managerSourceButton, ...(managerSource?.id === source.id ? managerSourceSelected : {}) }}><strong>{source.label}</strong><small title={source.identityLabel ?? undefined}>{source.identityLabel ?? source.kind} · {calendarSidebarGroups(presentation, calendars).find(group => group.id === source.id)?.rows.length ?? 0}</small></button>)}</nav>
        <section data-testid="calendar-source-details" style={managerDetails}>{managerSource ? <><h2 style={{ margin: 0 }}>{managerSource.label}</h2>{managerSource.identityLabel && <p title={managerSource.identityLabel} style={identityText}>{managerSource.identityLabel}</p>}<p style={{ margin: 0, color: 'var(--text-secondary)' }}>{managerSource.featureEnabled ? (managerRows.length ? `${managerRows.length} ${t('calendar.calendars')}` : t('calendar.noCalendarsDiscovered', 'No calendars discovered yet.')) : t('calendar.serviceDisabled', 'Calendar service is disabled.')}</p>{managerSource.accountId && <button type="button" data-testid="calendar-manager-account-sync" disabled={!managerSource.canSync || syncingAccountIds.has(managerSource.accountId)} onClick={() => runAccountCalendarSync(managerSource)} style={primaryButton}>{managerSource.canSync ? t('calendar.providerSync', { provider: managerSource.label }) : t('calendar.serviceDisabled', 'Calendar service is disabled.')}</button>}{managedExternalSource && <><SourceStatus source={managedExternalSource} pending={pendingSourceIds.current.has(managedExternalSource.id) || syncingSourceIds.has(managedExternalSource.id)} t={t} /><SourceIntervalSelect label={t('calendar.sourceSyncInterval')} value={managedExternalSource.intervalMin} onChange={value => changeSourceInterval(managedExternalSource, value)} t={t} /><div style={sourceActions}><button disabled={syncingSourceIds.has(managedExternalSource.id)} onClick={() => syncSource(managedExternalSource.id)} style={linkButton}>{t('calendar.syncSource')}</button><button onClick={() => removeSource(managedExternalSource.id)} style={dangerButton}>{t('calendar.delete')}</button></div></>}{managerRows.map(({ view, calendar }) => <div key={calendar.id} style={calendarRow}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{view.displayName}</span><label style={{ marginLeft: 'auto' }}><input type="checkbox" checked={isVisible(calendar.id)} onChange={() => onToggleCalendar(calendar.id)} /> {t('calendar.show', 'Show')}</label></div>)}</> : <p>{t('calendar.noSources', 'No calendar sources.')}</p>}</section>
      </div>
      {showAddSource && <form onSubmit={addSource} className="ui-form" style={formStyle}>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('calendar.icsWebcal')}</p>
        <label>{t('calendar.sourceName')}<input required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label>
        <label>{t('calendar.sourceUrl')}<input required type="url" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} /></label>
        <SourceIntervalSelect
          label={t('calendar.sourceSyncInterval')}
          value={form.intervalMin}
          onChange={value => setForm(current => ({ ...current, intervalMin: value }))}
          t={t}
        />
        <button type="submit" style={primaryButton}>{t('calendar.addSource')}</button>
      </form>}
    </Dialog>}
  </aside>;
}

// Sync cadence for one external calendar. The server accepts any whole number of
// minutes between 15 and 1440, so the control offers the values people actually
// choose rather than a free-text field that invites typos the server would reject.
const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440];

function SourceIntervalSelect({ label, value, onChange, t }: { label: string; value?: number; onChange: (value: number) => void; t: TFunction }) {
  const known = value != null && SYNC_INTERVALS.includes(value);
  const format = (minutes: number) => (minutes % 60 === 0 && minutes >= 60
    ? t('calendar.sourceSyncHours', { count: minutes / 60 })
    : t('calendar.sourceSyncMinutes', { count: minutes }));
  return <label style={intervalLabel}>{label}
    <select
      className="ui-select"
      data-testid="calendar-source-interval"
      value={known ? value : ''}
      onChange={event => onChange(Number(event.target.value))}
    >
      {/* A value set outside this list (an older custom value) stays selectable so
          opening the dialog never silently rewrites it. */}
      {!known && <option value="">{format(value || 60)}</option>}
      {SYNC_INTERVALS.map(minutes => <option key={minutes} value={minutes}>{format(minutes)}</option>)}
    </select>
  </label>;
}

function SourceStatus({ source, pending, t }: { source: { id: string; displayName?: string; kind?: string; intervalMin?: number; lastError?: string | null; lastSyncAt?: string | null; [key: string]: unknown }; pending: boolean; t: TFunction }) {
  const warning = calendarSyncWarning(source.lastError);
  if (pending) return <small>{t('calendar.sourceSyncing')}</small>;
  if (!warning) return <small>{t('calendar.sourceReady')}</small>;
  return <div><small role="status">{warning.count ? t('calendar.syncSkipped', { count: warning.count }) : t('calendar.syncFailed')}</small>
    <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>{t('calendar.syncDetails')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 140, overflow: 'auto', fontSize: 11 }}>{warning.details}</pre></details>
  </div>;
}

const panel: CSSProperties = { boxSizing: 'border-box', flexShrink: 0, padding: 14, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', overflow: 'auto' };
const miniMonth: CSSProperties = { display: 'grid', gap: 2, padding: 8, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8 };
const miniMonthHeading: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, fontWeight: 600, padding: '2px 4px 6px' }; const miniMonthNavigation: CSSProperties = { display: 'flex', gap: 2 }; const miniMonthButton: CSSProperties = { minWidth: 28, minHeight: 28, padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 18, fontWeight: 650, lineHeight: 1 };
const weekdayGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, padding: '3px 0' };
const dayGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 };
// Sizing lives in CSS (.calendar-mini-day / .calendar-mini-nav) so a sheet can raise
// the touch target without inline styles winning over it.
const dayButton = { margin: '0 auto', padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const today = { background: 'var(--accent)', color: 'var(--accent-text)', fontWeight: 600 }; const muted = { opacity: .38 };
const section: CSSProperties = { display: 'grid', gap: 4, paddingTop: 10 }; const sectionHeading: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }; const sourceHeading: CSSProperties = { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 4, minWidth: 0 }; const sourceHeadingText: CSSProperties = { display: 'grid', minWidth: 0, fontSize: 12, color: 'var(--text-primary)', letterSpacing: 0, textTransform: 'none' }; const identityText: CSSProperties = { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)', fontSize: 11 }; const chevronButton: CSSProperties = { width: 28, height: 28, border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18 }; const compactAction: CSSProperties = { width: 28, height: 28, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 16 };
const calendarRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, fontSize: 12.5, color: 'var(--text-secondary)' }; const calendarToggle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer' }; const colorDot = { width: 10, height: 10, borderRadius: 3 }; const readOnly: CSSProperties = { marginLeft: 'auto', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10 }; const owned: CSSProperties = { marginLeft: 'auto', color: 'var(--accent)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10 }; const menuWrap: CSSProperties = { position: 'relative' }; const menuButton: CSSProperties = { border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, padding: '0 6px' }; const contextMenu: CSSProperties = { position: 'absolute', right: 0, top: '100%', zIndex: 3, display: 'grid', minWidth: 150, padding: 4, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', boxShadow: '0 8px 22px rgba(0,0,0,.18)' };
const linkButton: CSSProperties = { border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 4, fontWeight: 650 }; const dangerButton: CSSProperties = { ...linkButton, color: 'var(--red)' }; const primaryButton: CSSProperties = { border: 0, borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-text)', padding: '8px 10px', cursor: 'pointer', fontWeight: 650 };
const managerToolbar: CSSProperties = { display: 'flex', gap: 8, marginBottom: 12 }; const managerLayout: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(180px, .8fr) minmax(0, 1.4fr)', border: '1px solid var(--border-subtle)', borderRadius: 8, minHeight: 280, overflow: 'hidden' }; const managerList: CSSProperties = { display: 'grid', alignContent: 'start', gap: 2, padding: 6, borderRight: '1px solid var(--border-subtle)', overflow: 'auto' }; const managerDetails: CSSProperties = { display: 'grid', alignContent: 'start', gap: 10, minWidth: 0, padding: 14, overflow: 'auto' }; const managerSourceButton: CSSProperties = { display: 'grid', gap: 2, minWidth: 0, padding: '9px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer' }; const managerSourceSelected: CSSProperties = { background: 'var(--bg-hover)' }; const formStyle: CSSProperties = { display: 'grid', gap: 10, minWidth: 0, marginTop: 14 }; const sourceActions: CSSProperties = { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, minWidth: 0 }; const intervalLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }; const error: CSSProperties = { color: 'var(--red)' };
