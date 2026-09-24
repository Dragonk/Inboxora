import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { toAppError } from '../utils/errors.ts';
import { calendarSyncWarning } from '../utils/calendarSyncWarning.ts';
import { summariseProviderSyncErrors } from '../utils/providerSyncError.ts';
import CalendarSubscriptionsSettings from './CalendarSubscriptionsSettings.tsx';
import { Button, Dialog, inputStyle } from './ui.tsx';
import { calendarSidebarGroups, calendarSourceCategory, canManageLocalCalendar, setCalendarSidebarHidden, type CalendarPresentation, type CalendarPresentationSource, type CalendarRow } from './calendarSettingsModel.ts';

interface Source { id: string; displayName?: string; kind?: string; intervalMin?: number; enabled?: boolean; lastError?: string | null; lastSyncAt?: string | null }
interface SyncOutcome {
  collections?: number; created?: number; updated?: number; deleted?: number;
  errors?: Array<{ code?: string; message?: string; providerStatus?: number | null; missingScopes?: string[] | null }>;
  error?: { code?: string; message?: string; providerStatus?: number | null; missingScopes?: string[] | null };
}
type DavMode = 'off' | 'read_only' | 'read_write';
const davMode = (value: unknown): DavMode => value === 'off' || value === 'read_only' ? value : 'read_write';

/** Canonical manager: service/collection actions never change event selection. */
export default function CalendarSettingsManager({ locale }: { locale?: string }) {
  const { t } = useTranslation();
  const authEpoch = useStore(state => state.authEpoch);
  const lifetime = useRef(0);
  const requests = useRef(0);
  const busyRef = useRef(false);
  const pollAttempts = useRef(new Map<string, number>());
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [calendars, setCalendars] = useState<CalendarRow[]>([]);
  const [presentation, setPresentation] = useState<CalendarPresentation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ calendar: CalendarRow; name: string; color: string; davMode: DavMode } | null>(null);
  const alive = useCallback((generation: number) => lifetime.current === generation && useStore.getState().authEpoch === authEpoch, [authEpoch]);
  const load = useCallback(async () => {
    const generation = lifetime.current;
    const request = ++requests.current;
    try {
      const [sourceResult, calendarResult, view] = await Promise.all([api.calendar.listSources(), api.calendar.listCalendars(), api.calendar.presentation()]);
      if (!alive(generation) || request !== requests.current) return;
      const loadedSources: Source[] = sourceResult.sources || [];
      setSources(loadedSources); setCalendars(calendarResult.calendars || []); setPresentation(view as CalendarPresentation);
      return loadedSources;
    } catch (caught) { if (alive(generation) && request === requests.current) setError(toAppError(caught).message); }
  }, [alive]);
  useLayoutEffect(() => {
    const lifecycle = lifetime;
    const requestCounter = requests;
    lifetime.current++;
    pollAttempts.current.clear();
    setSources([]); setCalendars([]); setPresentation(null); setDraft(null); setError(null); setNotice(null); setBusy(false); busyRef.current = false;
    void load();
    const changed = () => { void load(); };
    window.addEventListener('inboxora:calendar-changed', changed);
    return () => { lifecycle.current++; requestCounter.current++; window.removeEventListener('inboxora:calendar-changed', changed); };
  }, [load]);
  // Initial discovery is asynchronous. Refresh pending sources with a bounded,
  // cancellable poll rather than leaving newly created calendars invisible.
  useEffect(() => {
    const pending = sources.filter(source => !source.lastSyncAt && !source.lastError && source.enabled !== false);
    if (!pending.some(source => (pollAttempts.current.get(source.id) ?? 0) < 70)) return;
    const generation = lifetime.current;
    const timer = setTimeout(() => {
      if (!alive(generation)) return;
      pending.forEach(source => pollAttempts.current.set(source.id, (pollAttempts.current.get(source.id) ?? 0) + 1));
      void load().then(loaded => {
        if (alive(generation) && loaded?.some(source => pending.some(item => item.id === source.id) && (source.lastSyncAt || source.lastError))) {
          window.dispatchEvent(new Event('inboxora:calendar-changed'));
        }
      });
      if (pending.some(source => pollAttempts.current.get(source.id) === 70)) setError(t('calendar.sourceSyncTimeout', 'Source synchronization timed out.'));
    }, 500);
    return () => clearTimeout(timer);
  }, [sources, alive, load, t]);
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (busyRef.current) return;
    const generation = lifetime.current;
    const current = () => alive(generation);
    if (!current()) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await operation(current);
      if (!current()) return;
      window.dispatchEvent(new Event('inboxora:calendar-changed'));
    } catch (caught) { if (current()) setError(toAppError(caught).message); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  const groups = calendarSidebarGroups(presentation, calendars);
  const sourceLabels = {
    local: t('calendar.sourceCategoryLocal'), external: t('calendar.sourceCategoryExternal'),
    google: t('calendar.sourceCategoryGoogle'), microsoft: t('calendar.sourceCategoryMicrosoft'), system: t('calendar.sourceCategorySystem'),
  };
  const views = presentation?.sources ?? [];
  // A persisted source must remain actionable even after a failed initial discovery.
  const entries: CalendarPresentationSource[] = [...views, ...sources.filter(source => !views.some(view => view.id === `calendar-source:${source.id}`)).map(source => ({
    id: `calendar-source:${source.id}`, kind: source.kind ?? 'ical_url', label: source.displayName ?? source.id,
    accountId: null, identityLabel: null, featureEnabled: true, canSync: true, collapsed: false,
  }))].filter(source => `${source.label} ${source.identityLabel ?? ''} ${groups.find(group => group.id === source.id)?.rows.map(row => row.calendar.name).join(' ') ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const entry = entries.find(source => source.id === selected) ?? entries[0];
  const external = sources.find(source => `calendar-source:${source.id}` === entry?.id);
  const rows = groups.find(group => group.id === entry?.id)?.rows ?? [];
  const syncAccount = (source: CalendarPresentationSource) => run(async current => {
    if (!source.accountId || !source.canSync) return;
    const response = await api.syncAccountProviderFeature(source.accountId, 'calendars') as { state?: string; result?: SyncOutcome };
    if (!current()) return;
    const outcome = response.result ?? {};
    const failed = (outcome.error ? 1 : 0) + (outcome.errors?.length ?? 0);
    const values = { provider: source.label, calendars: outcome.collections ?? 0, created: outcome.created ?? 0, updated: outcome.updated ?? 0, deleted: outcome.deleted ?? 0, failed };
    const summary = summariseProviderSyncErrors({ t, provider: source.kind === 'microsoft' ? 'microsoft' : 'google', feature: 'calendar', errors: [outcome.error, ...(outcome.errors ?? [])] });
    setNotice(response.state !== 'success' || failed ? `${t('calendar.providerSyncPartial', values)} ${summary?.first ?? ''}`.trim() : t('calendar.providerSyncDone', values));
  });
  return <section data-testid="calendar-settings-manager" style={{ display: 'grid', gap: 14 }}>
    {error && <p role="alert" className="ui-alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <input data-testid="calendar-source-search" aria-label={t('calendar.searchSources', 'Search sources or calendars')} placeholder={t('calendar.searchSources', 'Search sources or calendars')} value={search} onChange={event => setSearch(event.target.value)} style={inputStyle} />
      <Button data-testid="calendar-add-source" onClick={() => setAdding(value => !value)}>{adding ? t('calendar.cancel') : t('calendar.addSource')}</Button>
    </div>
    {adding && <CalendarSubscriptionsSettings locale={locale} creationOnly />}
    <div data-testid="calendar-source-manager" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <nav aria-label={t('calendar.manageSources')} style={{ display: 'grid', alignContent: 'start', gap: 6, flex: '1 1 180px', minWidth: 0 }}>
        {entries.map(source => <Button key={source.id} data-testid="calendar-manager-source" aria-pressed={entry?.id === source.id} variant={entry?.id === source.id ? 'primary' : 'secondary'} onClick={() => setSelected(source.id)}><span style={{ display: 'grid', overflowWrap: 'anywhere' }}><strong>{source.label}</strong><small>{source.identityLabel || sourceLabels[calendarSourceCategory(source)]}</small></span></Button>)}
      </nav>
      <section data-testid="calendar-source-details" style={{ display: 'grid', alignContent: 'start', gap: 12, flex: '3 1 300px', minWidth: 0 }}>
        {entry ? <>
          <h2 style={{ margin: 0 }}>{entry.label}</h2>
          {entry.identityLabel && <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{entry.identityLabel}</p>}
          {!entry.featureEnabled && <p role="status">{t('calendar.serviceDisabled', 'Calendar service is disabled.')}</p>}
          {entry.accountId && <>
            <Button data-testid="calendar-manager-account-sync" disabled={busy || !entry.canSync} onClick={() => syncAccount(entry)}>{t('calendar.providerSync', { provider: entry.label })}</Button>
            <p className="settings-choice-description">{t('calendar.providerManagedHint', 'Calendar creation, renaming and deletion are managed by the provider. Configure account services in Settings → Accounts.')}</p>
          </>}
          {external && <>
            <p role="status">{external.lastError ? calendarSyncWarning(external.lastError)?.details : t(external.lastSyncAt ? 'calendar.sourceReady' : 'calendar.sourceSyncing')}</p>
            <label>{t('calendar.sourceSyncInterval')}<select data-testid="calendar-source-interval" disabled={busy} value={external.intervalMin ?? 60} onChange={event => { const intervalMin = Number(event.target.value); void run(async () => { await api.calendar.updateSource(external.id, { intervalMin }); }); }}>
              {Array.from(new Set([15, 30, 60, 180, 360, 720, 1440, external.intervalMin ?? 60])).sort((a, b) => a - b).map(minutes => <option key={minutes} value={minutes}>{t('calendar.sourceSyncMinutes', { count: minutes })}</option>)}
            </select></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Button disabled={busy} onClick={() => run(async () => { await api.calendar.updateSource(external.id, { enabled: !external.enabled }); })}>{t(external.enabled ? 'calendar.pauseSource' : 'calendar.resumeSource')}</Button>
              <Button disabled={busy || !external.enabled} onClick={() => run(async () => { await api.calendar.syncSource(external.id); })}>{t('calendar.syncSource')}</Button>
              <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(t('calendar.removeSourceConfirm'))) void run(async () => { await api.calendar.deleteSource(external.id); }); }}>{t('calendar.delete')}</Button>
            </div>
          </>}
          {!rows.length && <p>{t('calendar.noCalendarsDiscovered', 'No calendars discovered yet.')}</p>}
          {rows.map(({ calendar, view }) => <div key={calendar.id} data-testid="calendar-manager-calendar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
            <strong style={{ flex: '1 1 140px' }}>{calendar.name}</strong>
            <Button data-testid="calendar-manager-visibility" disabled={busy} onClick={() => run(async () => { await setCalendarSidebarHidden(api.calendar.updateCalendarPresentation, calendar.id, !view.sidebarHidden); })}>{view.sidebarHidden ? t('calendar.show', 'Show') : t('calendar.hide', 'Hide from list')}</Button>
            {calendar.collection_id && <Button data-testid="calendar-write-back" disabled={busy} onClick={() => run(async () => { await api.setCollectionWriteBack(calendar.collection_id!, Boolean(calendar.read_only)); })}>{t(calendar.read_only ? 'calendar.enableWriteBack' : 'calendar.disableWriteBack')}</Button>}
            {canManageLocalCalendar(calendar) && <>
              <Button disabled={busy} onClick={() => { setNotice(null); setError(null); setDraft({ calendar, name: calendar.name ?? '', color: calendar.color || '#35558a', davMode: davMode(calendar.dav_mode) }); }}>{t('calendar.calendarActions', { name: calendar.name })}</Button>
              <Button variant="danger" disabled={busy || !calendar.name} onClick={() => { if (calendar.name && window.confirm(t('calendar.confirmCalendarDelete', { name: calendar.name }))) void run(async () => { await api.calendar.deleteCalendar(calendar.id, calendar.name!); }); }}>{t('calendar.deleteCalendar')}</Button>
            </>}
          </div>)}
        </> : <p>{t('calendar.subscribeEmpty')}</p>}
      </section>
    </div>
    {draft && <Dialog testId="calendar-appearance-dialog" title={t('calendar.calendarActions', { name: draft.calendar.name })} closeLabel={t('calendar.close')} busy={busy} onClose={() => setDraft(null)} footer={<Button variant="primary" disabled={busy || !draft.name.trim() || !/^#[0-9a-f]{6}$/i.test(draft.color)} onClick={() => run(async current => {
      await api.calendar.updateCalendar(draft.calendar.id, { name: draft.name.trim(), color: draft.color, displayVisible: draft.calendar.display_visible !== false, customName: true, davMode: draft.davMode });
      if (current()) setDraft(null);
    })}>{t('calendar.save')}</Button>}>
      <div className="ui-form">
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status" data-testid="calendar-import-result">{notice}</p>}
        <label>{t('calendar.renamePrompt')}<input maxLength={120} disabled={busy} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>{t('calendar.changeColor')}<input type="color" disabled={busy} value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
        <label>{t('calendar.davAccess')}<select data-testid="calendar-dav-mode" disabled={busy} value={draft.davMode} onChange={event => setDraft({ ...draft, davMode: davMode(event.target.value) })}><option value="off">{t('calendar.davAccessOff')}</option><option value="read_only">{t('calendar.davAccessReadOnly')}</option><option value="read_write">{t('calendar.davAccessReadWrite')}</option></select></label>
        <p>{t('calendar.davAccessHint')}</p>
        <label>{t('calendar.importIcs')}<input data-testid="calendar-import-ics" type="file" accept=".ics,text/calendar" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void run(async current => {
            const text = await file.text();
            if (!current()) return;
            const result = await api.calendar.importIcs(draft.calendar.id, text) as { imported?: number; protected?: number };
            if (current()) setNotice(`${t('calendar.importDone', { count: result.imported ?? 0 })}${result.protected ? ` ${t('calendar.importProtected', { count: result.protected })}` : ''}`);
          });
        }} /></label>
      </div>
    </Dialog>}
  </section>;
}
