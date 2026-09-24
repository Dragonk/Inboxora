import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { Button, Dialog } from './ui.tsx';
import ServiceSettingsView, { ConnectionFeature, type ServiceConnection, type ServiceResource } from './accountUi/ServiceSettingsView.tsx';
import { Header, Icon, Notice, Status, Switch } from './accountUi/AccountUi.tsx';
import { bookSourceId, featureState, providerLabel, syncFailed, type BookIdentity } from './accountUi/model.ts';
import { openSettings, useSettingsTarget, type SettingsTarget } from './accountUi/navigation.ts';
import { useProviderAccounts, useAccountOperation } from './accountUi/useAccounts.ts';
import DavSourceEditor, { type DavSource } from './accountUi/DavSourceEditor.tsx';
import DeleteResourceDialog from './accountUi/DeleteResourceDialog.tsx';

export interface ManagerBook {
  id: string; name: string; source: string; visible: boolean; readOnly: boolean;
  collectionId: string | null; accountLabel: string | null; accountId: string | null; connectionId: string | null;
  canSyncProvider: boolean; contactCount: number | null; syncStatus: { key: string | null; values: Record<string, string> } | null;
  davSourceId?: string | null; sourceLabel?: string | null; sourceUrl?: string | null; sourceUsername?: string | null;
  accountName?: string | null; sourceAccess?: string | null; davMode?: 'off' | 'read_only' | 'read_write';
}
export interface ManagerProviderState { configured: boolean; connected: boolean }
export interface ContactsBooksManagerProps {
  open: boolean; onClose: () => void; books: readonly ManagerBook[]; selectedBookId: string; onSelectBook: (id: string) => void; isMobile: boolean;
  t: (key: string, values?: Record<string, unknown>) => string;
  onCreate: () => void; onRename: (book: ManagerBook) => void; onToggleVisibility: () => void; onToggleWriteBack: () => void; writingBack: boolean;
  canDelete: boolean; onDelete: () => void; deleting: boolean; deleteError: string | null;
  google: ManagerProviderState; microsoft: ManagerProviderState; dav: ManagerProviderState;
  onDavChanged: () => void | Promise<void>; syncing: 'google' | 'microsoft' | 'dav' | null; onSync: (provider: 'google' | 'microsoft' | 'dav') => void;
  googleSummary: { key: string | null; values: Record<string, string> } | null; microsoftSummary: { key: string | null; values: Record<string, string> } | null;
  onImportGoogleCsv: () => void; onImportVCard: () => void; exportUrl: (format: string) => string;
  davMode: 'off' | 'read_only' | 'read_write'; onDavModeChange: (mode: 'off' | 'read_only' | 'read_write') => void; davBusy: boolean;
  view?: 'accounts' | 'resources' | 'import'; loading?: boolean;
}
const asBook = (book: ManagerBook): BookIdentity => ({ id: book.id, name: book.name, source: book.source, account_id: book.accountId,
  connection_id: book.connectionId, dav_source_id: book.davSourceId, source_label: book.sourceLabel, source_url: book.sourceUrl, source_username: book.sourceUsername,
  account_email: book.accountLabel, account_name: book.accountName, read_only: book.readOnly, visible: book.visible, contact_count: book.contactCount });

export default function ContactsBooksManager(props: ContactsBooksManagerProps) {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const provider = useProviderAccounts(); const operation = useAccountOperation();
  const [davSources, setDavSources] = useState<DavSource[]>([]); const [davLoading, setDavLoading] = useState(true); const [davFailed, setDavFailed] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null); const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false); const [davEditor, setDavEditor] = useState<DavSource | 'new' | null>(null);
  const [editing, setEditing] = useState<{ book: ManagerBook; name: string; visible: boolean; writeBack: boolean; davMode: 'off' | 'read_only' | 'read_write' } | null>(null);
  const [deleting, setDeleting] = useState<ManagerBook | null>(null); const [disconnecting, setDisconnecting] = useState<DavSource | null>(null);
  const [target, setTarget] = useState<SettingsTarget | null>(null); const [targetMissing, setTargetMissing] = useState(false);
  const life = useRef(0);
  const loadDav = useCallback(async () => {
    const generation = life.current;
    try {
      const response = await api.carddav.status() as { sources?: DavSource[] };
      if (generation !== life.current || useStore.getState().authEpoch !== epoch) return;
      setDavSources(Array.isArray(response.sources) ? response.sources : []); setDavFailed(false);
    } catch { if (generation === life.current && useStore.getState().authEpoch === epoch) setDavFailed(true); }
    finally { if (generation === life.current && useStore.getState().authEpoch === epoch) setDavLoading(false); }
  }, [epoch]);
  useEffect(() => { life.current++; setSelectedSourceId(null); setEditing(null); setDeleting(null); setDavSources([]); setDavLoading(true); void loadDav(); const cancel = () => { life.current++; }; return cancel; }, [loadDav]);
  const refresh = async () => { await props.onDavChanged(); await Promise.all([provider.refresh(), loadDav()]); };
  const resources: ServiceResource[] = props.books.map(book => ({ id: book.id, sourceId: bookSourceId(asBook(book)), name: book.name || t('accountUi.unnamed'), visible: book.visible, readOnly: book.readOnly, count: book.contactCount }));
  const connections = useMemo(() => {
    const result = new Map<string, ServiceConnection>();
    for (const account of provider.accounts) {
      const snapshot = provider.snapshots[account.id];
      const kind = snapshot?.provider ?? (account.mail_transport === 'gmail_api' ? 'google' : account.mail_transport === 'microsoft_graph' ? 'microsoft' : null);
      if (!kind) continue;
      const id = `${kind}:account:${account.id}`;
      result.set(id, { id, kind, accountId: account.id, name: account.name || providerLabel(kind, t), identity: account.email_address,
        color: account.color, count: props.books.filter(book => book.accountId === account.id).length,
        lastSync: snapshot?.diagnostics?.contacts?.lastSuccessfulSync, state: featureState(snapshot?.contacts) });
    }
    for (const source of davSources) {
      if (!source.id) continue;
      const id = `carddav:source:${source.id}`;
      result.set(id, { id, kind: 'carddav', name: source.label || 'CardDAV', identity: source.username || source.serverUrl,
        count: source.bookCount, lastSync: source.lastSyncAt, state: source.lastError ? 'failed' : source.lastSyncAt ? 'ready' : source.connected ? 'pending' : 'unknown' });
    }
    for (const book of props.books) {
      const id = bookSourceId(asBook(book));
      if (id === 'local' || result.has(id)) continue;
      result.set(id, { id, kind: book.source, accountId: book.accountId, name: book.sourceLabel || providerLabel(book.source, t), identity: book.accountLabel || book.sourceUsername,
        count: props.books.filter(item => bookSourceId(asBook(item)) === id).length, state: 'unknown' });
    }
    return [...result.values()];
  }, [props.books, provider.accounts, provider.snapshots, davSources, t]);
  useSettingsTarget('contacts', setTarget);
  useEffect(() => {
    if (target?.module !== 'contacts' || props.loading || provider.loading || davLoading) return;
    setTargetMissing(false);
    if (target.resourceId) {
      const book = props.books.find(item => item.id === target.resourceId);
      if (book) { props.onSelectBook(book.id); setEditing({ book, name: book.name, visible: book.visible, writeBack: !book.readOnly, davMode: book.davMode ?? 'off' }); setFilter(bookSourceId(asBook(book))); }
      else setTargetMissing(true);
    } else if (target.sourceId || target.accountId) {
      const source = connections.find(item => item.id === target.sourceId || Boolean(target.accountId && item.accountId === target.accountId));
      if (target.section === 'resources') setFilter(target.sourceId === 'local' ? 'local' : source?.id ?? 'all');
      else if (source) setSelectedSourceId(source.id);
      else setTargetMissing(true);
    }
    setTarget(null);
  }, [target, props, provider.loading, davLoading, connections]);
  const openResources = (sourceId?: string) => openSettings({ module: 'contacts', section: 'resources', sourceId });
  const runRefresh = (action: () => Promise<unknown>) => void operation.run(async current => { await action(); if (current()) await refresh(); });
  const visibility = (id: string, visible: boolean) => runRefresh(() => api.addressBooks.update(id, { visible }));
  const editResource = (id: string) => { const book = props.books.find(item => item.id === id); if (!book) return; props.onSelectBook(id); setEditing({ book, name: book.name, visible: book.visible, writeBack: !book.readOnly, davMode: book.davMode ?? 'off' }); };
  const renderDetail = (source: ServiceConnection) => {
    const snapshot = source.accountId ? provider.snapshots[source.accountId] : undefined;
    const dav = davSources.find(item => `carddav:source:${item.id}` === source.id);
    const ownedBooks = props.books.filter(book => bookSourceId(asBook(book)) === source.id);
    return <>
      <Header title={source.name} description={`${providerLabel(source.kind, t)}${source.identity ? ` · ${source.identity}` : ''}`}>{source.accountId && <Button onClick={() => openSettings({ module: 'accounts', accountId: source.accountId!, section: 'services' })}>{t('accountUi.accountSettings')}</Button>}</Header>
      {source.accountId && <ConnectionFeature title={t('accountUi.syncContacts')} description={t('accountUi.independentService')} feature={snapshot?.contacts} busy={operation.busy} onChange={enabled => runRefresh(() => api.setAccountProviderFeature(source.accountId!, 'contacts', enabled))}/>}
      <section className="au-section"><h3>{t('accountUi.connectionState')}</h3><dl className="au-meta"><dt>{t('accountUi.synchronization')}</dt><dd><Status state={source.state}/></dd><dt>{t('accountUi.books')}</dt><dd>{ownedBooks.length}</dd>{dav?.serverUrl && <><dt>{t('accountUi.serverUrl')}</dt><dd className="au-mono">{dav.serverUrl}</dd></>}</dl>
        <div className="au-actions"><Button disabled={operation.busy || (!dav && !snapshot?.contacts?.authorized) || snapshot?.contacts?.enabled === false} onClick={() => runRefresh(async () => {
          const response = source.accountId ? await api.syncAccountProviderFeature(source.accountId, 'contacts') : dav ? await api.carddav.sync(dav.id) : null;
          if (syncFailed(response)) throw new Error('PROVIDER_SYNC_FAILED');
        })}><Icon name="sync"/>{t('accountUi.syncNow')}</Button>{dav && <Button onClick={() => setDavEditor(dav)}>{t('accountUi.editConnection')}</Button>}</div>
      </section>
      <section className="au-section"><h3>{t('accountUi.booksOnAccount')}</h3><div className="au-resource-group">{ownedBooks.map(book => <div className="au-resource" key={book.id}><div className="au-grow"><strong>{book.name}</strong><small>{t(book.readOnly ? 'accountUi.readOnly' : 'accountUi.readWrite')}</small></div><Button onClick={() => editResource(book.id)}>{t('accountUi.resourceSettings')}</Button></div>)}</div>{!ownedBooks.length && <p className="au-note">{t('accountUi.noResources')}</p>}<div className="au-actions"><Button onClick={() => openResources(source.id)}>{t('accountUi.showResources')}</Button></div></section>
      {dav && <section className="au-section"><p>{t('accountUi.disconnectHint')}</p><Button variant="danger" onClick={() => setDisconnecting(dav)}>{t('accountUi.disconnect')}</Button></section>}
    </>;
  };
  if (!props.open) return null;
  const selectedBook = props.books.find(book => book.id === props.selectedBookId);
  const view = props.view ?? 'resources';
  return <div className="au-workspace" data-testid="contacts-books-manager">
    {(operation.failed || davFailed) && <Notice danger>{t('accountUi.operationFailed')}</Notice>}
    {targetMissing && <Notice danger>{t('accountUi.targetUnavailable')}</Notice>}
    {view === 'import' ? <>
      <Header title={t('accountUi.importExport')} description={t('accountUi.importDescription')}/>
      <label className="au-field"><span>{t('accountUi.targetBook')}</span><select value={props.selectedBookId} onChange={event => props.onSelectBook(event.target.value)}><option value="">{t('accountUi.chooseResource')}</option>{props.books.map(book => <option value={book.id} key={book.id}>{book.name}{book.accountLabel ? ` · ${book.accountLabel}` : ''}</option>)}</select></label>
      <section className="au-operation"><h3>{t('accountUi.importContacts')}</h3><p>{t('accountUi.localImportOnly')}</p><div className="au-actions"><Button disabled={!selectedBook || selectedBook.source !== 'local'} onClick={props.onImportVCard}>{t('accountUi.formatVcard')}</Button><Button disabled={!selectedBook || selectedBook.source !== 'local'} onClick={props.onImportGoogleCsv}>{t('accountUi.formatGoogleCsv')}</Button></div></section>
      <section className="au-operation"><h3>{t('accountUi.exportContacts')}</h3><div className="au-actions">{[['vcard',t('accountUi.formatVcard')],['google-csv',t('accountUi.formatGoogleCsv')],['outlook-csv',t('accountUi.formatOutlookCsv')]].map(([format,label]) => <Button disabled={!selectedBook} key={format} onClick={() => { if (selectedBook) window.location.assign(props.exportUrl(format)); }}>{label}</Button>)}</div></section>
    </> : <ServiceSettingsView contacts view={view} connections={connections} resources={resources} selectedSourceId={selectedSourceId} onSelectSource={setSelectedSourceId} onAddConnection={() => setAdding(true)} onCreateResource={props.onCreate} onOpenResources={openResources} onEditResource={editResource} onVisibility={visibility} renderDetail={renderDetail} filter={filter} onFilter={setFilter} busy={operation.busy} loading={props.loading || provider.loading || davLoading}/>}
    {adding && <Dialog title={t('accountUi.addAccount')} closeLabel={t('common.close')} onClose={() => setAdding(false)}><div className="au-workspace"><p className="au-note">{t('accountUi.chooseConnection')}</p><div className="au-actions"><Button onClick={() => { setAdding(false); openSettings({ module: 'accounts', add: true }); }}>{t('accountUi.providersNative')}</Button><Button onClick={() => { setAdding(false); setDavEditor('new'); }}>{t('accountUi.brandCardDAV')}</Button></div></div></Dialog>}
    {davEditor && <DavSourceEditor key={davEditor === 'new' ? 'new' : davEditor.id} kind="carddav" source={davEditor === 'new' ? undefined : davEditor} onClose={() => setDavEditor(null)} onChanged={refresh}/>}
    {editing && <Dialog title={t('accountUi.resourceSettings')} closeLabel={t('common.close')} busy={operation.busy} onClose={() => setEditing(null)} footer={<><Button disabled={operation.busy} onClick={() => setEditing(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={operation.busy || !editing.name.trim()} onClick={() => void operation.run(async current => {
      const book = editing.book;
      await api.addressBooks.update(book.id, { visible: editing.visible, ...(book.source === 'local' ? { name: editing.name.trim(), davMode: editing.davMode } : {}) });
      if (!current()) return;
      if (book.collectionId && editing.writeBack !== !book.readOnly) {
        await api.setCollectionWriteBack(book.collectionId, editing.writeBack);
        if (!current()) return;
      }
      await refresh(); if (current()) setEditing(null);
    })}>{t('common.save')}</Button></>}>
      <div className="ui-form au-workspace">{operation.failed && <Notice danger>{t('accountUi.partialSave')}</Notice>}<label>{t('accountUi.resourceName')}<input value={editing.name} maxLength={120} disabled={operation.busy} readOnly={editing.book.source !== 'local'} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label><p className="au-note">{editing.book.accountLabel}</p><div className="au-switch-row"><strong>{t('accountUi.visibleInApplication')}</strong><Switch checked={editing.visible} label={t('accountUi.visibleInApplication')} disabled={operation.busy} onChange={visible => setEditing({ ...editing, visible })}/></div>
      {editing.book.collectionId && <div className="au-switch-row"><div><strong>{t('accountUi.writeBack')}</strong><p>{t('accountUi.sourceRightsHint')}</p></div><Switch checked={editing.writeBack} label={t('accountUi.writeBack')} disabled={operation.busy || editing.book.sourceAccess === 'read_only'} onChange={writeBack => setEditing({ ...editing, writeBack })}/></div>}
      {editing.book.source === 'local' && <label>{t('accountUi.davSharing')}<select disabled={operation.busy} value={editing.davMode} onChange={event => setEditing({ ...editing, davMode: event.target.value === 'off' || event.target.value === 'read_only' ? event.target.value : 'read_write' })}><option value="off">{t('accountUi.statusOff')}</option><option value="read_only">{t('accountUi.readOnly')}</option><option value="read_write">{t('accountUi.readWrite')}</option></select></label>}
      {editing.book.source === 'local' && <div className="au-section"><Button variant="danger" disabled={props.books.filter(book => book.source === 'local').length < 2} onClick={() => setDeleting(editing.book)}>{t('accountUi.deleteResource')}</Button></div>}
      </div>
    </Dialog>}
    {deleting && <DeleteResourceDialog name={deleting.name} identity={deleting.accountLabel ?? t('accountUi.storedInInboxora')} busy={operation.busy} failed={operation.failed} onClose={() => setDeleting(null)} onConfirm={() => void operation.run(async current => { await api.addressBooks.remove(deleting.id); if (current()) { await refresh(); if (current()) { setDeleting(null); setEditing(null); } } })}/>}
    {disconnecting && <Dialog title={t('accountUi.disconnect')} closeLabel={t('common.close')} busy={operation.busy} onClose={() => setDisconnecting(null)} footer={<><Button onClick={() => setDisconnecting(null)} disabled={operation.busy}>{t('common.cancel')}</Button><Button variant="danger" disabled={operation.busy} onClick={() => void operation.run(async current => { await api.carddav.disconnect(disconnecting.id); if (current()) { await refresh(); if (current()) { setDisconnecting(null); setSelectedSourceId(null); } } })}>{t('accountUi.disconnect')}</Button></>}><Notice danger>{t('accountUi.disconnectHint')}</Notice>{operation.failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</Dialog>}
  </div>;
}
