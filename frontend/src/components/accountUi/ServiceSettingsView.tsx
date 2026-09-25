import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
import { intlLocale } from '../../utils/intlLocale.ts';
import { Back, Card, Check, Header, Icon, IconButton, ProviderMark, Status } from './AccountUi.tsx';
import type { FeatureFacts } from './model.ts';
import { featureState } from './model.ts';

export interface ServiceConnection {
  id: string; name: string; identity?: string | null; kind: string; accountId?: string | null;
  color?: string | null; count?: number | null; lastSync?: string | null; state: ReturnType<typeof featureState>;
}
export interface ServiceResource {
  id: string; sourceId: string; name: string; visible: boolean; readOnly: boolean; count?: number | null; color?: string | null;
}
export interface ServiceSettingsViewProps {
  contacts: boolean; view: 'accounts' | 'resources'; connections: readonly ServiceConnection[]; resources: readonly ServiceResource[];
  selectedSourceId: string | null; onSelectSource: (id: string | null) => void;
  onAddConnection: () => void; onCreateResource: () => void; onOpenResources: (sourceId?: string) => void;
  onEditResource: (id: string) => void; onVisibility: (id: string, visible: boolean) => void;
  renderDetail: (source: ServiceConnection) => ReactNode;
  filter: string; onFilter: (filter: string) => void; busy?: boolean; loading?: boolean;
}
export default function ServiceSettingsView(props: ServiceSettingsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language);
  const [search, setSearch] = useState('');
  const contacts = props.contacts;
  const selected = props.connections.find(source => source.id === props.selectedSourceId);
  const local = props.resources.filter(resource => resource.sourceId === 'local');
  const readableCount = (count: number | null | undefined) => typeof count === 'number' ? new Intl.NumberFormat(locale).format(count) : '—';
  if (props.view === 'accounts' && selected) return <div className="au-workspace">
    <Back onClick={() => props.onSelectSource(null)}>{t('accountUi.allAccounts')}</Back>{props.renderDetail(selected)}
  </div>;
  if (props.view === 'accounts') return <div className="au-workspace">
    <Header title={t(contacts ? 'accountUi.contactAccounts' : 'accountUi.calendarAccounts')} description={t(contacts ? 'accountUi.contactAccountsDescription' : 'accountUi.calendarAccountsDescription')}><Button variant="primary" onClick={props.onAddConnection}><Icon name="plus" size={13}/>{t('accountUi.addAccount')}</Button></Header>
    {props.loading && <p className="au-note" role="status">{t('common.loading')}</p>}
    {!props.loading && !props.connections.length && <div className="au-empty">{t('accountUi.noAccounts')}</div>}
    {props.connections.map(source => <Card key={source.id} name={source.name} identity={source.identity} kind={source.kind} color={source.color} onManage={() => props.onSelectSource(source.id)} status={<Status state={source.state}/>} metadata={<><span>{t(contacts ? 'accountUi.books' : 'accountUi.calendars')} <strong>{readableCount(source.count)}</strong></span><span>{t('accountUi.lastSync')} <span className="au-mono">{source.lastSync && Number.isFinite(Date.parse(source.lastSync)) ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(source.lastSync)) : '—'}</span></span><span className="au-tail">{t(source.kind === 'google' ? (contacts ? 'accountUi.transportGoogleContacts' : 'accountUi.transportGoogleCalendar') : source.kind === 'microsoft' ? 'accountUi.transportMicrosoft' : source.kind === 'carddav' ? 'accountUi.brandCardDAV' : 'accountUi.brandCalDAV')}</span></>}/>) }
    <div className="au-section-label">{t('accountUi.storedInInboxora')}</div><div className="au-local-card"><ProviderMark kind="local"/><div className="au-grow"><strong>{t(contacts ? 'accountUi.localBooks' : 'accountUi.localCalendars')}</strong><p>{t('accountUi.localResources', { count: local.length })}</p></div><Button variant="ghost" onClick={() => props.onOpenResources('local')}>{t('accountUi.manage')}<Icon name="chevron" size={12}/></Button></div>
    <p className="au-note">{t(contacts ? 'accountUi.visibilityHint' : 'accountUi.subscriptionsHint')}</p>
  </div>;
  const matching = props.resources.filter(resource => (props.filter === 'all' || resource.sourceId === props.filter) && resource.name.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)));
  const groups = [...new Set(matching.map(resource => resource.sourceId))];
  return <div className="au-workspace">
    <Header title={t(contacts ? 'accountUi.books' : 'accountUi.calendars')} description={t('accountUi.resourcesDescription')}><Button variant="primary" onClick={props.onCreateResource}><Icon name="plus" size={13}/>{t(contacts ? 'accountUi.newBook' : 'accountUi.newCalendar')}</Button></Header>
    <div className="au-filters"><input type="search" aria-label={t('accountUi.searchResources')} placeholder={t('accountUi.searchResources')} value={search} onChange={event => setSearch(event.target.value)}/><select aria-label={t('accountUi.filterAccount')} value={props.filter} onChange={event => props.onFilter(event.target.value)}><option value="all">{t('accountUi.allAccounts')}</option><option value="local">{t('accountUi.storedInInboxora')}</option>{props.connections.map(source => <option key={source.id} value={source.id}>{source.name}{source.identity ? ` · ${source.identity}` : ''}</option>)}</select></div>
    {groups.map(id => {
      const source = props.connections.find(item => item.id === id);
      return <section key={id}><div className="au-resource-group-title"><ProviderMark kind={source?.kind ?? 'local'}/><strong>{source?.name ?? t('accountUi.storedInInboxora')}</strong>{source?.identity && <span className="au-muted">· {source.identity}</span>}</div><div className="au-resource-group">{matching.filter(resource => resource.sourceId === id).map(resource => <div key={resource.id} className="au-resource" data-resource-id={resource.id}>
        <label className="au-resource-label"><Check checked={resource.visible} disabled={props.busy} onChange={event => props.onVisibility(resource.id, event.target.checked)}/>{!contacts && <span className="au-color-dot" style={{ background: resource.color || 'var(--accent)' }}/>}<span className="au-grow"><strong>{resource.name}</strong>{typeof resource.count === 'number' && <small>{t(contacts ? 'accountUi.contactsNumber' : 'accountUi.eventsNumber', { count: resource.count })}</small>}{!resource.visible && <small>{t('accountUi.hidden')}</small>}</span></label>
        <span className="au-badge">{resource.readOnly && <Icon name="lock" size={10}/>} {t(resource.readOnly ? 'accountUi.readOnly' : 'accountUi.readWrite')}</span><IconButton icon="settings" label={t('accountUi.settingsFor', { name: resource.name })} onClick={() => props.onEditResource(resource.id)}/>
      </div>)}</div></section>;
    })}
    {!matching.length && <div className="au-empty">{t('accountUi.noResources')}</div>}
    <p className="au-note">{t('accountUi.visibilityHint')}</p>
  </div>;
}
export function ConnectionFeature({ title, description, feature, onChange, busy }: { title: string; description: string; feature?: FeatureFacts | null; onChange: (enabled: boolean) => void; busy: boolean }) {
  // Imported here to keep all services on the exact same switch grammar.
  return <div className="au-switch-row"><div className="au-grow"><strong>{title}</strong><p>{description}</p></div><button type="button" className="au-switch" role="switch" aria-label={title} aria-checked={feature?.enabled === true} disabled={busy || !feature} onClick={() => onChange(feature?.enabled !== true)}><span/></button></div>;
}
