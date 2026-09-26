import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { localizeContactCalendar } from '../utils/contactDateLabels.ts';
import { intlLocale } from '../utils/intlLocale.ts';
import { HOLIDAY_CALENDARS, HOLIDAY_SYNC_INTERVAL_MIN, defaultHolidayCountry, holidayCalendarUrl, holidayCountryName, normalizeSubscriptionUrl } from '../utils/calendarSubscriptions.ts';
import { Button, Dialog } from './ui.tsx';
import { calendarSidebarGroups, type CalendarPresentation, type CalendarRow } from './calendarSettingsModel.ts';
import { operationKey, nativeCalendarDeleteAllowed, type NativeCalendarOperationResponse } from './calendarCollectionManagementModel.ts';
import ServiceSettingsView, { ConnectionFeature, type ServiceConnection, type ServiceResource } from './accountUi/ServiceSettingsView.tsx';
import { Header, Notice, Status, Switch, Icon } from './accountUi/AccountUi.tsx';
import { featureState, sourceLabel, colorValue, syncFailed } from './accountUi/model.ts';
import { openSettings, useSettingsTarget, type SettingsTarget } from './accountUi/navigation.ts';
import { useProviderAccounts, useAccountOperation } from './accountUi/useAccounts.ts';
import DavSourceEditor from './accountUi/DavSourceEditor.tsx';
import DeleteResourceDialog from './accountUi/DeleteResourceDialog.tsx';
import { previewCalendarColor } from './accountUi/calendarPreview.ts';

type DavMode = 'off' | 'read_only' | 'read_write';
interface Source { id: string; displayName?: string; kind?: string; url?: string; serverOrigin?: string; username?: string; intervalMin?: number; enabled?: boolean; lastError?: string | null; lastSyncAt?: string | null }
interface NativeIntent { accountId: string; action: 'create' | 'delete'; idempotencyKey: string; name?: string; collectionId?: string; response: NativeCalendarOperationResponse }
interface ResourceDraft { calendar: CalendarRow; name: string; color: string; reset: boolean; colorDirty: boolean; writeBack: boolean; davMode: DavMode }

/** Accounts, collections and imports are separate screens sharing one controller. */
export default function CalendarSettingsManager({ locale, view = 'accounts' }: { locale?: string; view?: 'accounts' | 'resources' | 'import' }) {
  const { t, i18n } = useTranslation(); const epoch = useStore(state => state.authEpoch); const userId = useStore(state => state.user?.id);
  const language = intlLocale(locale || i18n.resolvedLanguage || i18n.language) || 'en';
  const provider = useProviderAccounts(); const operation = useAccountOperation();
  const [sources, setSources] = useState<Source[]>([]); const [rawCalendars, setCalendars] = useState<CalendarRow[]>([]);
  const calendars = useMemo(() => rawCalendars.map(calendar => localizeContactCalendar(calendar, t) as CalendarRow), [rawCalendars, t]);
  const [presentation, setPresentation] = useState<CalendarPresentation | null>(null); const [loading, setLoading] = useState(true); const [readFailed, setReadFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); const [filter, setFilter] = useState('all'); const [adding, setAdding] = useState(false);
  const [davEditor, setDavEditor] = useState<Source | 'new' | null>(null); const [editing, setEditing] = useState<ResourceDraft | null>(null);
  const [deleting, setDeleting] = useState<CalendarRow | null>(null); const [disconnecting, setDisconnecting] = useState<Source | null>(null);
  const [forgetting, setForgetting] = useState<ServiceConnection | null>(null);
  const [create, setCreate] = useState<{ name: string; color: string; accountId: string } | null>(null);
  const [pending, setPending] = useState<Record<string, NativeIntent>>({}); const [target, setTarget] = useState<SettingsTarget | null>(null); const [missing, setMissing] = useState(false);
  const [ics, setIcs] = useState<{ name: string; url: string; interval: number } | null>(null);
  const [importTarget, setImportTarget] = useState(''); const [file, setFile] = useState<File | null>(null); const [imported, setImported] = useState<{ imported: number; protected: number } | null>(null);
  const [country, setCountry] = useState(() => defaultHolidayCountry(language));
  const life = useRef(0); const request = useRef(0);
  const load = useCallback(async () => {
    const generation = life.current; const ticket = ++request.current;
    try {
      const [sourceResult, calendarResult, model] = await Promise.all([api.calendar.listSources(), api.calendar.listCalendars(), api.calendar.presentation()]);
      if (generation !== life.current || ticket !== request.current || useStore.getState().authEpoch !== epoch) return;
      setSources(sourceResult.sources || []); setCalendars(calendarResult.calendars || []); setPresentation(model as CalendarPresentation); setReadFailed(false);
    } catch { if (generation === life.current && ticket === request.current && useStore.getState().authEpoch === epoch) setReadFailed(true); }
    finally { if (generation === life.current && ticket === request.current && useStore.getState().authEpoch === epoch) setLoading(false); }
  }, [epoch]);
  useEffect(() => {
    life.current++; setSources([]); setCalendars([]); setPresentation(null); setSelected(null); setEditing(null); setLoading(true); setPending({});
    void load(); const changed = () => { void load(); }; const cancel = () => { life.current++; request.current++; };
    window.addEventListener('inboxora:calendar-changed', changed);
    return () => { cancel(); window.removeEventListener('inboxora:calendar-changed', changed); };
  }, [load]);
  const needsDiscovery = sources.some(source => source.enabled !== false && !source.lastSyncAt && !source.lastError);
  // Bounded discovery/status refresh. No blind write retry is performed.
  useEffect(() => {
    if (!needsDiscovery) return;
    let attempts = 0; const timer = setInterval(() => { attempts++; void load(); if (attempts >= 20) clearInterval(timer); }, 1500);
    return () => clearInterval(timer);
  }, [load, needsDiscovery]);
  const storageKey = (accountId: string) => `inboxora:calendar-lifecycle:${String(userId)}:${accountId}`;
  useEffect(() => {
    const restored: Record<string, NativeIntent> = {};
    for (const account of provider.accounts) {
      try {
        const key = `inboxora:calendar-lifecycle:${String(userId)}:${account.id}`;
        const legacyKey = `inboxora:calendar-lifecycle:${account.id}`;
        const stored = sessionStorage.getItem(key);
        const legacy = stored ? null : sessionStorage.getItem(legacyKey);
        let value: Partial<NativeIntent> | null = stored ? JSON.parse(stored) as Partial<NativeIntent> : null;
        if (!value && legacy) {
          const previous = JSON.parse(legacy) as { intent?: Partial<NativeIntent>; operation?: NativeCalendarOperationResponse };
          if (previous.intent && previous.operation) value = { ...previous.intent, accountId: account.id, response: previous.operation };
        }
        if (!value) continue;
        if (value.accountId === account.id && (value.action === 'create' || value.action === 'delete') && typeof value.idempotencyKey === 'string' && value.response && value.response.state !== 'confirmed') {
          restored[account.id] = value as NativeIntent;
          if (legacy) { sessionStorage.setItem(key, JSON.stringify(value)); sessionStorage.removeItem(legacyKey); }
        }
      } catch { setReadFailed(true); }
    }
    setPending(restored);
  }, [provider.accounts, userId]);
  const previewId = editing?.calendar.id; const previewColor = editing?.color;
  useEffect(() => {
    if (!previewId) return;
    if (colorValue(previewColor)) previewCalendarColor(previewId, previewColor!, epoch);
    return () => previewCalendarColor(previewId, null, epoch);
  }, [previewId, previewColor, epoch]);
  const refresh = async () => { await Promise.all([load(), provider.refresh()]); window.dispatchEvent(new Event('inboxora:calendar-changed')); };
  const runRefresh = (action: () => Promise<unknown>) => void operation.run(async current => { await action(); if (current()) await refresh(); });
  const groups = useMemo(() => calendarSidebarGroups(presentation, calendars), [presentation, calendars]);
  const connections: ServiceConnection[] = useMemo(() => (presentation?.sources ?? [])
    .filter(source => source.kind !== 'local')
    .filter(source => !['google', 'microsoft'].includes(source.kind) || Boolean(source.accountId))
    .map(source => {
    const external = sources.find(item => `calendar-source:${item.id}` === source.id);
    const snapshot = source.accountId ? provider.snapshots[source.accountId] : undefined;
    const account = provider.accounts.find(item => item.id === source.accountId);
    const state = external ? external.enabled === false ? 'off' : external.lastError ? 'failed' : external.lastSyncAt ? 'ready' : 'pending'
      : source.kind === 'system' ? 'ready' : featureState(snapshot?.calendar);
    return { id: source.id, kind: source.kind, accountId: source.accountId, name: sourceLabel(source, t, provider.accounts), identity: source.identityLabel || (external?.username ? `${external.username}${external.serverOrigin ? ` · ${external.serverOrigin}` : ''}` : external?.serverOrigin),
      color: account?.color, count: groups.find(group => group.id === source.id)?.rows.length ?? 0,
      lastSync: external?.lastSyncAt ?? snapshot?.diagnostics?.calendar?.lastSuccessfulSync, state };
  }), [presentation, sources, provider.snapshots, provider.accounts, groups, t]);
  const accountConnections = connections.filter(connection =>
    ['google', 'microsoft', 'caldav'].includes(connection.kind)
    || connection.id.startsWith('collection:')
  );
  const resources: ServiceResource[] = groups.flatMap(group => group.rows.map(({ calendar, view: row }) => ({ id: calendar.id, sourceId: group.id,
    name: calendar.id === 'contacts-birthdays' && !calendar.custom_name ? t('accountUi.contactDates') : calendar.name || t('accountUi.unnamed'),
    color: calendar.color, visible: !row.sidebarHidden, readOnly: calendar.read_only === true })));
  const sourceForCalendar = (id: string) => groups.find(group => group.rows.some(row => row.calendar.id === id));
  const openResources = (sourceId?: string) => openSettings({ module: 'calendar', section: 'resources', sourceId });
  const edit = (id: string) => {
    const calendar = calendars.find(item => item.id === id); if (!calendar) return;
    setEditing({ calendar, name: calendar.name ?? '', color: calendar.color || '#35558a', reset: false, colorDirty: false, writeBack: calendar.read_only === false,
      davMode: calendar.dav_mode === 'off' || calendar.dav_mode === 'read_only' ? calendar.dav_mode : 'read_write' });
  };
  useSettingsTarget('calendar', setTarget);
  useEffect(() => {
    if (target?.module !== 'calendar' || loading) return;
    setMissing(false);
    if (target.resourceId) {
      const calendar = calendars.find(item => item.id === target.resourceId);
      if (calendar) {
        setEditing({ calendar, name: calendar.name ?? '', color: calendar.color || '#35558a', reset: false, colorDirty: false, writeBack: calendar.read_only === false,
          davMode: calendar.dav_mode === 'off' || calendar.dav_mode === 'read_only' ? calendar.dav_mode : 'read_write' });
        setFilter(groups.find(group => group.rows.some(row => row.calendar.id === target.resourceId))?.id ?? 'all');
      } else setMissing(true);
    }
    else if (target.sourceId || target.accountId) {
      const source = connections.find(connection => connection.id === target.sourceId || Boolean(target.accountId && connection.accountId === target.accountId));
      if (target.section === 'resources') setFilter(target.sourceId === 'local' ? 'local' : source?.id ?? 'all');
      else if (source) setSelected(source.id); else setMissing(true);
    }
    setTarget(null);
  }, [target, loading, calendars, connections, groups]);
  const sendNative = async (intent: NativeIntent) => {
    const generation = life.current;
    const current = () => generation === life.current && useStore.getState().authEpoch === epoch;
    if (!current()) return false;
    // Persist the idempotency key before sending; never lose it on a navigation/reload.
    sessionStorage.setItem(storageKey(intent.accountId), JSON.stringify(intent)); setPending(previous => ({ ...previous, [intent.accountId]: intent }));
    try {
      const response = await (intent.action === 'create'
        ? api.createAccountProviderCalendar(intent.accountId, { name: intent.name!, idempotencyKey: intent.idempotencyKey })
        : api.deleteAccountProviderCalendar(intent.accountId, intent.collectionId!, { idempotencyKey: intent.idempotencyKey })) as NativeCalendarOperationResponse;
      if (!current()) return false;
      if (response.state === 'confirmed') { sessionStorage.removeItem(storageKey(intent.accountId)); setPending(previous => { const next = { ...previous }; delete next[intent.accountId]; return next; }); return true; }
      const next = { ...intent, response }; sessionStorage.setItem(storageKey(intent.accountId), JSON.stringify(next)); setPending(previous => ({ ...previous, [intent.accountId]: next })); return false;
    } catch (error) {
      if (current()) { const next: NativeIntent = { ...intent, response: { state: 'outcome_unknown' } }; sessionStorage.setItem(storageKey(intent.accountId), JSON.stringify(next)); setPending(previous => ({ ...previous, [intent.accountId]: next })); }
      throw error;
    }
  };
  const createCalendar = () => void operation.run(async current => {
    if (!create?.name.trim()) return;
    let confirmed = true;
    if (!create.accountId) await api.calendar.createCalendar({ name: create.name.trim(), color: create.color, displayVisible: true });
    else {
      if (pending[create.accountId]) return;
      confirmed = await sendNative({ accountId: create.accountId, action: 'create', name: create.name.trim(), idempotencyKey: operationKey(), response: { state: 'pending' } });
    }
    if (current()) { await refresh(); if (current() && confirmed) setCreate(null); }
  });
  const deleteCalendar = () => void operation.run(async current => {
    if (!deleting?.name) return;
    let confirmed = true;
    if (deleting.source === 'local') await api.calendar.deleteCalendar(deleting.id, deleting.name);
    else {
      const accountId = sourceForCalendar(deleting.id)?.accountId;
      if (!accountId || !deleting.collection_id || pending[accountId]) return;
      confirmed = await sendNative({ accountId, collectionId: deleting.collection_id, action: 'delete', idempotencyKey: operationKey(), response: { state: 'pending' } });
    }
    if (current()) { await refresh(); if (current() && confirmed) { setDeleting(null); setEditing(null); } }
  });
  const saveResource = () => void operation.run(async current => {
    if (!editing) return;
    const calendar = editing.calendar;
    if (calendar.source === 'local' || calendar.id === 'contacts-birthdays') {
      await api.calendar.updateCalendar(calendar.id, { name: editing.name.trim(), color: Object.prototype.hasOwnProperty.call(calendar, 'source_color') ? colorValue(calendar.source_color) : colorValue(calendar.color),
        displayVisible: calendar.display_visible !== false, customName: calendar.custom_name === true || editing.name.trim() !== calendar.name, ...(calendar.source === 'local' ? { davMode: editing.davMode } : {}) });
      if (!current()) return;
    }
    if (editing.colorDirty) await api.calendar.updateCalendarColorOverride(calendar.id, editing.reset ? null : editing.color);
    if (!current()) return;
    if (calendar.collection_id && editing.writeBack !== (calendar.read_only === false)) {
      await api.setCollectionWriteBack(calendar.collection_id, editing.writeBack);
      if (!current()) return;
    }
    if (current()) { await refresh(); if (current()) setEditing(null); }
  });
  const sourceDetail = (connection: ServiceConnection) => {
    const snapshot = connection.accountId ? provider.snapshots[connection.accountId] : undefined;
    const external = sources.find(source => `calendar-source:${source.id}` === connection.id);
    const legacyExternal = !external
      && !connection.accountId
      && connection.id.startsWith('collection:')
      && (connection.kind === 'caldav' || connection.kind === 'ical_url');
    const rows = resources.filter(resource => resource.sourceId === connection.id);
    return <>
      <Header title={connection.name} description={connection.identity}>{connection.accountId && <Button onClick={() => openSettings({ module: 'accounts', accountId: connection.accountId!, section: 'services' })}>{t('accountUi.accountSettings')}</Button>}</Header>
      {connection.accountId && <ConnectionFeature title={t('accountUi.syncCalendars')} description={t('accountUi.independentService')} feature={snapshot?.calendar} busy={operation.busy} onChange={enabled => runRefresh(() => api.setAccountProviderFeature(connection.accountId!, 'calendars', enabled))}/>}
      {external && <div className="au-switch-row"><div><strong>{t('accountUi.syncCalendars')}</strong><p>{t('accountUi.pauseHint')}</p></div><Switch label={t('accountUi.syncCalendars')} checked={external.enabled !== false} disabled={operation.busy} onChange={enabled => runRefresh(() => api.calendar.updateSource(external.id, { enabled }))}/></div>}
      <section className="au-section"><h3>{t('accountUi.connectionState')}</h3><dl className="au-meta"><dt>{t('accountUi.synchronization')}</dt><dd><Status state={connection.state}/></dd><dt>{t('accountUi.calendars')}</dt><dd>{rows.length}</dd>{external?.url && <><dt>{t('accountUi.serverUrl')}</dt><dd className="au-mono">{external.url}</dd></>}</dl><div className="au-actions"><Button disabled={operation.busy || connection.state === 'off' || connection.state === 'authorization' || connection.state === 'unknown'} onClick={() => runRefresh(async () => {
        if (external) { const response = await api.calendar.syncSource(external.id); if (syncFailed(response)) throw new Error('PROVIDER_SYNC_FAILED'); return; }
        if (!connection.accountId) return;
        const response = await api.syncAccountProviderFeature(connection.accountId, 'calendars');
        if (syncFailed(response)) throw new Error('PROVIDER_SYNC_FAILED');
      })}><Icon name="sync"/>{t('accountUi.syncNow')}</Button>{external && <Button onClick={() => setDavEditor(external)}>{t('accountUi.editConnection')}</Button>}</div></section>
      <section className="au-section"><h3>{t('accountUi.calendarsOnAccount')}</h3><div className="au-resource-group">{rows.map(resource => <div className="au-resource" key={resource.id}><span className="au-color-dot" style={{ background: resource.color || 'var(--accent)' }}/><div className="au-grow"><strong>{resource.name}</strong><small>{t(resource.readOnly ? 'accountUi.readOnly' : 'accountUi.readWrite')}</small></div><Button onClick={() => edit(resource.id)}>{t('accountUi.resourceSettings')}</Button></div>)}</div><div className="au-actions"><Button onClick={() => openResources(connection.id)}>{t('accountUi.showResources')}</Button>{connection.accountId && <Button disabled={operation.busy || Boolean(pending[connection.accountId])} onClick={() => setCreate({ name: '', color: '#35558a', accountId: connection.accountId! })}>{t('accountUi.newCalendar')}</Button>}</div></section>
      {external && <section className="au-section"><p>{t('accountUi.disconnectHint')}</p><Button variant="danger" onClick={() => setDisconnecting(external)}>{t('accountUi.disconnect')}</Button></section>}
      {legacyExternal && <section className="au-section"><p>{t('accountUi.disconnectHint')}</p><Button variant="danger" onClick={() => setForgetting(connection)}>{t('accountUi.disconnect')}</Button></section>}
    </>;
  };
  const imports = <>
    <Header title={t('accountUi.importSubscriptions')} description={t('accountUi.calendarImportDescription')}/>
    <section className="au-operation"><h3>{t('accountUi.importIcs')}</h3><p>{t('accountUi.calendarImportDescription')}</p><label className="au-field"><span>{t('accountUi.targetCalendar')}</span><select value={importTarget} onChange={event => { setImportTarget(event.target.value); setImported(null); }}><option value="">{t('accountUi.chooseResource')}</option>{calendars.filter(calendar => calendar.source === 'local').map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label><input type="file" accept=".ics,text/calendar" aria-label={t('accountUi.importIcs')} onChange={event => { setFile(event.target.files?.[0] ?? null); setImported(null); }}/><div className="au-actions"><Button disabled={!file || !importTarget || operation.busy} onClick={() => void operation.run(async current => {
      if (!file) return; const text = await file.text(); if (!current()) return;
      const result = await api.calendar.importIcs(importTarget, text) as { imported?: number; protected?: number };
      if (current()) { setImported({ imported: result.imported ?? 0, protected: result.protected ?? 0 }); await refresh(); }
    })}>{t('accountUi.import')}</Button></div>{imported && <Notice>{t('accountUi.importResult', { count: imported.imported, protected: imported.protected })}</Notice>}</section>
    <section className="au-operation"><h3>{t('accountUi.icsSubscription')}</h3><p>{t('accountUi.icsHint')}</p><Button onClick={() => setIcs({ name: '', url: '', interval: 60 })}>{t('accountUi.addSubscription')}</Button></section>
    <section className="au-operation"><h3>{t('accountUi.holidays')}</h3><label className="au-field"><span>{t('accountUi.country')}</span><select value={country} onChange={event => setCountry(event.target.value)}>{HOLIDAY_CALENDARS.map(entry => <option key={entry.code} value={entry.code}>{holidayCountryName(entry.code, language)}</option>)}</select></label><Button disabled={operation.busy} onClick={() => runRefresh(async () => { const entry = HOLIDAY_CALENDARS.find(item => item.code === country); if (entry) await api.calendar.createSource({ kind: 'ical_url', displayName: t('calendar.holidayName', { country: holidayCountryName(country, language) }), url: holidayCalendarUrl(entry.file), intervalMin: HOLIDAY_SYNC_INTERVAL_MIN }); })}>{t('accountUi.addSubscription')}</Button></section>
    <div className="au-section-label">{t('accountUi.subscriptions')}</div>{sources.filter(source => source.kind !== 'caldav').map(source => <div className="au-account-card" key={source.id}><div className="au-account-main"><div className="au-grow"><div className="au-account-name">{source.displayName}</div><div className="au-account-status"><Status state={source.enabled === false ? 'off' : source.lastError ? 'failed' : source.lastSyncAt ? 'ready' : 'pending'}/></div></div><Switch label={t('accountUi.synchronization')} checked={source.enabled !== false} disabled={operation.busy} onChange={enabled => runRefresh(() => api.calendar.updateSource(source.id, { enabled }))}/><Button onClick={() => setDisconnecting(source)}>{t('accountUi.disconnect')}</Button></div></div>)}
  </>;
  return <div className="au-workspace" data-testid="calendar-settings-manager">
    {(readFailed || operation.failed) && <Notice danger>{t('accountUi.operationFailed')}<Button onClick={() => void load()}>{t('accountUi.retry')}</Button></Notice>}
    {missing && <Notice danger>{t('accountUi.targetUnavailable')}</Notice>}
    {Object.values(pending).map(intent => <Notice key={intent.accountId}>{t('accountUi.operationPending')} <span className="au-mono">{intent.response.code ?? intent.response.state}</span>{(intent.response.state === 'pending' || intent.response.state === 'retryable') && <Button disabled={operation.busy} onClick={() => void operation.run(async current => { await sendNative(intent); if (current()) await refresh(); })}>{t('accountUi.checkOperation')}</Button>}</Notice>)}
    {view === 'import' ? imports : <ServiceSettingsView contacts={false} view={view} connections={view === 'accounts' ? accountConnections : connections} resources={resources} selectedSourceId={selected} onSelectSource={setSelected} onAddConnection={() => setAdding(true)} onCreateResource={() => setCreate({ name: '', color: '#35558a', accountId: '' })} onOpenResources={openResources} onEditResource={edit} onVisibility={(id, visible) => runRefresh(() => api.calendar.updateCalendarPresentation(id, !visible))} renderDetail={sourceDetail} filter={filter} onFilter={setFilter} loading={loading} busy={operation.busy}/>}
    {adding && <Dialog title={t('accountUi.addAccount')} closeLabel={t('common.close')} onClose={() => setAdding(false)}><p className="au-note">{t('accountUi.chooseConnection')}</p><div className="au-actions"><Button onClick={() => { setAdding(false); openSettings({ module: 'accounts', add: true }); }}>{t('accountUi.providersNative')}</Button><Button onClick={() => { setAdding(false); setDavEditor('new'); }}>{t('accountUi.brandCalDAV')}</Button></div></Dialog>}
    {davEditor && <DavSourceEditor key={davEditor === 'new' ? 'new' : davEditor.id} kind="caldav" source={davEditor === 'new' ? undefined : { id: davEditor.id, label: davEditor.displayName, serverUrl: davEditor.serverOrigin || davEditor.url, username: davEditor.username, intervalMin: davEditor.intervalMin }} onClose={() => setDavEditor(null)} onChanged={refresh}/>}
    {create && <Dialog title={t('accountUi.newCalendar')} closeLabel={t('common.close')} onClose={() => setCreate(null)} busy={operation.busy} footer={<><Button disabled={operation.busy} onClick={() => setCreate(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={operation.busy || !create.name.trim() || Boolean(create.accountId && (!provider.snapshots[create.accountId]?.calendar?.calendarManagement?.authorized || pending[create.accountId]))} onClick={createCalendar}>{t('common.save')}</Button></>}><div className="ui-form au-workspace"><label>{t('accountUi.storageLocation')}<select value={create.accountId} disabled={operation.busy} onChange={event => setCreate({ ...create, accountId: event.target.value })}><option value="">{t('accountUi.storedInInboxora')}</option>{accountConnections.filter(source => source.accountId).map(source => <option key={source.id} value={source.accountId!}>{source.name} · {source.identity}</option>)}</select></label><label>{t('accountUi.resourceName')}<input value={create.name} maxLength={create.accountId ? 255 : 120} disabled={operation.busy} onChange={event => setCreate({ ...create, name: event.target.value })}/></label>{!create.accountId && <label>{t('accountUi.eventColor')}<input type="color" value={create.color} onChange={event => setCreate({ ...create, color: event.target.value })}/></label>}{create.accountId && !provider.snapshots[create.accountId]?.calendar?.calendarManagement?.authorized && <Notice>{t('accountUi.managementAuthorization')}<Button onClick={() => {
      if (provider.snapshots[create.accountId]?.provider === 'google') window.location.assign(`/oauth/google?purpose=calendar_enable&accountId=${encodeURIComponent(create.accountId)}&manageCalendars=1`);
      else openSettings({ module: 'accounts', accountId: create.accountId, section: 'services' });
    }}>{t('accountUi.accountSettings')}</Button></Notice>}{operation.failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</div></Dialog>}
    {editing && <Dialog title={t('accountUi.resourceSettings')} closeLabel={t('common.close')} onClose={() => setEditing(null)} busy={operation.busy} footer={<><Button disabled={operation.busy} onClick={() => setEditing(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={operation.busy || !editing.name.trim() || !colorValue(editing.color)} onClick={saveResource}>{t('common.save')}</Button></>}><div className="ui-form au-workspace">
      {operation.failed && <Notice danger>{t('accountUi.partialSave')}</Notice>}
      <label>{t('accountUi.resourceName')}<input value={editing.name} maxLength={120} disabled={operation.busy} readOnly={editing.calendar.source !== 'local' && editing.calendar.id !== 'contacts-birthdays'} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label>
      <label>{t('accountUi.eventColor')}<div className="au-color-inputs"><input type="color" value={colorValue(editing.color) ?? '#35558a'} aria-label={t('accountUi.customColor')} disabled={operation.busy} onChange={event => setEditing({ ...editing, color: event.target.value, reset: false, colorDirty: true })}/><input type="text" value={editing.color} aria-label={t('accountUi.hexColor')} maxLength={7} disabled={operation.busy} onChange={event => setEditing({ ...editing, color: event.target.value, reset: false, colorDirty: true })}/></div></label><Button variant="ghost" disabled={operation.busy} onClick={() => setEditing({ ...editing, color: colorValue(editing.calendar.source_color) ?? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), reset: true, colorDirty: true })}>{t('accountUi.resetColor')}</Button><p className="au-note">{t('accountUi.colorIsPersonal')}</p>
      {editing.calendar.collection_id && <div className="au-switch-row"><div><strong>{t('accountUi.writeBack')}</strong><p>{t('accountUi.sourceRightsHint')}</p></div><Switch checked={editing.writeBack} label={t('accountUi.writeBack')} disabled={operation.busy || editing.calendar.source_access === 'read_only'} onChange={writeBack => setEditing({ ...editing, writeBack })}/></div>}
      {editing.calendar.source === 'local' && <label>{t('accountUi.davSharing')}<select value={editing.davMode} disabled={operation.busy} onChange={event => setEditing({ ...editing, davMode: event.target.value === 'off' || event.target.value === 'read_only' ? event.target.value : 'read_write' })}><option value="off">{t('accountUi.statusOff')}</option><option value="read_only">{t('accountUi.readOnly')}</option><option value="read_write">{t('accountUi.readWrite')}</option></select></label>}
      {(editing.calendar.source === 'local' || nativeCalendarDeleteAllowed(editing.calendar)) && <div className="au-section"><Button variant="danger" disabled={operation.busy} onClick={() => setDeleting(editing.calendar)}>{t('accountUi.deleteResource')}</Button></div>}
    </div></Dialog>}
    {deleting && <DeleteResourceDialog name={deleting.name ?? ''} remote={deleting.source !== 'local'} identity={sourceForCalendar(deleting.id)?.identityLabel ?? undefined} busy={operation.busy} failed={operation.failed} onClose={() => setDeleting(null)} onConfirm={deleteCalendar}/>}
    {disconnecting && <Dialog title={t('accountUi.disconnect')} closeLabel={t('common.close')} busy={operation.busy} onClose={() => setDisconnecting(null)} footer={<><Button disabled={operation.busy} onClick={() => setDisconnecting(null)}>{t('common.cancel')}</Button><Button variant="danger" disabled={operation.busy} onClick={() => void operation.run(async current => { await api.calendar.deleteSource(disconnecting.id); if (current()) { await refresh(); if (current()) { setDisconnecting(null); setSelected(null); } } })}>{t('accountUi.disconnect')}</Button></>}><Notice danger>{t('accountUi.disconnectHint')}</Notice>{operation.failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</Dialog>}
    {forgetting && <Dialog title={t('accountUi.disconnect')} closeLabel={t('common.close')} busy={operation.busy} onClose={() => setForgetting(null)} footer={<><Button disabled={operation.busy} onClick={() => setForgetting(null)}>{t('common.cancel')}</Button><Button variant="danger" disabled={operation.busy} onClick={() => void operation.run(async current => { await api.calendar.forgetLegacySource(forgetting.id); if (current()) { await refresh(); if (current()) { setForgetting(null); setSelected(null); } } })}>{t('accountUi.disconnect')}</Button></>}><Notice danger>{t('accountUi.disconnectHint')}</Notice>{operation.failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</Dialog>}
    {ics && <Dialog title={t('accountUi.icsSubscription')} closeLabel={t('common.close')} onClose={() => setIcs(null)} busy={operation.busy} footer={<><Button disabled={operation.busy} onClick={() => setIcs(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={operation.busy || !ics.name.trim() || !ics.url.trim()} onClick={() => void operation.run(async current => { await api.calendar.createSource({ kind: 'ical_url', displayName: ics.name.trim(), url: normalizeSubscriptionUrl(ics.url), intervalMin: ics.interval }); if (current()) { await refresh(); if (current()) setIcs(null); } })}>{t('accountUi.addSubscription')}</Button></>}><div className="ui-form"><label>{t('accountUi.resourceName')}<input value={ics.name} onChange={event => setIcs({ ...ics, name: event.target.value })}/></label><label>{t('accountUi.serverUrl')}<input value={ics.url} onChange={event => setIcs({ ...ics, url: event.target.value })}/></label><label>{t('accountUi.syncInterval')}<select value={ics.interval} onChange={event => setIcs({ ...ics, interval: Number(event.target.value) })}>{[15,30,60,180,1440].map(minutes => <option key={minutes} value={minutes}>{t('accountUi.intervalMinutes', { count: minutes })}</option>)}</select></label>{operation.failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</div></Dialog>}
  </div>;
}
