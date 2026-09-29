import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.ts';
import { useStore } from '../../store/index.ts';
import { intlLocale } from '../../utils/intlLocale.ts';
import { Button, Dialog } from '../ui.tsx';
import { Icon, IconButton, Notice, Switch } from './AccountUi.tsx';
import { SectionTabs } from './SettingsSections.tsx';
import InlineEditor from './InlineEditor.tsx';
import { useAccountOperation } from './useAccounts.ts';

export interface DavAccount {
  id: string; name: string; serverUrl: string; username: string; calendarEnabled: boolean; contactsEnabled: boolean;
  calendarSupported: boolean; contactsSupported: boolean; intervalMin: number; revision: string;
}
interface Discovery { calendarSupported: boolean; contactsSupported: boolean; calendarCount: number; contactBookCount: number }
interface SourceStatus { id: string; name?: string; enabled: boolean; last_sync_at: string | null; failed: boolean }
interface Diagnostics { calendars: SourceStatus[]; contacts: SourceStatus[] }
const errorKeys: Record<string,string> = {
  DAV_INVALID_URL:'davAccount.invalidUrl', DAV_HTTPS_REQUIRED:'davAccount.httpsRequired', DAV_HOST_BLOCKED:'davAccount.hostBlocked',
  DAV_AUTH_FAILED:'davAccount.authFailed', DAV_DISCOVERY_FAILED:'davAccount.discoveryFailed', DAV_NOT_SUPPORTED:'davAccount.unsupported',
  DAV_SERVICE_UNAVAILABLE:'davAccount.serviceUnavailable', DAV_COLLECTION_ALREADY_CONNECTED:'davAccount.alreadyConnected',
  DAV_ACCOUNT_NOT_FOUND:'accountUi.targetUnavailable', DAV_ACCOUNT_CHANGED:'davAccount.changed', DAV_OPERATION_PENDING:'davAccount.operationPending',
  DAV_INVALID_SETTINGS:'davAccount.invalidSettings',
};
function errorKey(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return errorKeys[code] || 'accountUi.operationFailed';
}
export function DavAccountsList({ onEdit }: {onEdit:(account:DavAccount)=>void}) {
  const { t } = useTranslation(); const epoch = useStore(state=>state.authEpoch);
  const [accounts,setAccounts]=useState<DavAccount[]>([]); const [loading,setLoading]=useState(true);
  const [error,setError]=useState(''); const [deleting,setDeleting]=useState<DavAccount|null>(null);
  const life=useRef({ generation: 0 }); const operation=useAccountOperation();
  const load=useCallback(async()=>{
    const generation=++life.current.generation; setLoading(true);
    try { const result:{accounts:DavAccount[]}=await api.get('/dav-accounts');
      if (generation===life.current.generation && useStore.getState().authEpoch===epoch) {setAccounts(result.accounts);setError('');}
    } catch (error) {if (generation===life.current.generation && useStore.getState().authEpoch===epoch) setError(errorKey(error));}
    finally {if (generation===life.current.generation && useStore.getState().authEpoch===epoch) setLoading(false);}
  },[epoch]);
  useEffect(()=>{const scope=life.current;void load();return()=>{scope.generation++;};},[load]);
  const remove=()=>void operation.run(async current=>{
    if (!deleting) return; const id=deleting.id;
    try {await api.delete(`/dav-accounts/${encodeURIComponent(id)}`);if (!current()) return;setDeleting(null);await load();}
    catch (error) {if (current()) setError(errorKey(error));}
  });
  return <section className="au-workspace" data-testid="dav-accounts">
    {error && <Notice danger>{t(error)}<Button disabled={operation.busy} onClick={()=>void load()}>{t('common.retry')}</Button></Notice>}
    {loading && <p role="status">{t('common.loading')}</p>}
    {accounts.map(account=><article className="au-account-card" key={account.id} data-testid={`dav-account-${account.id}`}>
      <div className="au-account-main"><Icon name="cloud" size={22}/><div className="au-grow"><strong>{account.name} · {t('davAccount.title')}</strong>
        <p className="au-note">{account.username} · {account.serverUrl}</p><p className="au-note">
          {t('calendar.calendars')}: {t(account.calendarEnabled ? 'admin.notifications.badgeOn' : 'accountUi.statusOff')} · {t('contacts.title')}: {t(account.contactsEnabled ? 'admin.notifications.badgeOn' : 'accountUi.statusOff')}
        </p></div><Button onClick={()=>onEdit(account)}>{t('common.edit')}</Button>
        <IconButton icon="trash" className="au-danger" label={`${t('common.remove')}: ${account.name}`} onClick={()=>{setError('');setDeleting(account);}}/>
      </div></article>)}
    {deleting && <Dialog title={t('davAccount.removeTitle')} onClose={()=>{if (!operation.busy) setDeleting(null);}} busy={operation.busy}
      closeLabel={t('common.close')} footer={<><Button disabled={operation.busy} onClick={()=>setDeleting(null)}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={operation.busy} onClick={remove}>{t('common.remove')}</Button></>}>
      <p>{t('davAccount.removeDescription',{name:deleting.name})}</p>{error && <Notice danger>{t(error)}</Notice>}
    </Dialog>}
  </section>;
}
function DavDiagnostics({ account }: {account:DavAccount}) {
  const {t,i18n}=useTranslation();const epoch=useStore(state=>state.authEpoch);
  const [status,setStatus]=useState<Diagnostics|null>(null);const [error,setError]=useState('');const serial=useRef({ generation: 0 });
  const operation=useAccountOperation();
  const load=useCallback(async()=>{
    const current=++serial.current.generation;
    try {const data:Diagnostics=await api.get(`/dav-accounts/${encodeURIComponent(account.id)}/diagnostics`);
      if (current===serial.current.generation && useStore.getState().authEpoch===epoch) {setStatus(data);setError('');}}
    catch (error) {if (current===serial.current.generation && useStore.getState().authEpoch===epoch) setError(errorKey(error));}
  },[account.id,epoch]);
  useEffect(()=>{const scope=serial.current;void load();const timer=window.setInterval(()=>void load(),5000);return()=>{scope.generation++;clearInterval(timer);};},[load]);
  const sync=()=>void operation.run(async current=>{
    try {await api.post(`/dav-accounts/${encodeURIComponent(account.id)}/sync`,{});if (current()) await load();}
    catch(error){if(current())setError(errorKey(error));}
  });
  const date=(value:string|null)=>value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(intlLocale(i18n.resolvedLanguage||i18n.language),{dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : t('common.never');
  return <div className="au-workspace"><Button disabled={operation.busy || (!account.calendarEnabled && !account.contactsEnabled)} onClick={sync}>{t('accountUi.syncNow')}</Button>
    {error && <Notice danger>{t(error)}</Notice>}{!status && !error && <p role="status">{t('common.loading')}</p>}
    {status && [...status.calendars.map(source=>({...source,label:source.name || t('calendar.calendars')})),...status.contacts.map(source=>({...source,label:t('contacts.title')}))].map(source=>
      <div className="au-section" key={source.id}><strong>{source.label}</strong><dl className="au-meta"><dt>{t('settingsIndex.status')}</dt><dd>{t(!source.enabled ? 'accountUi.statusOff' : source.failed ? 'accountUi.statusFailed' : source.last_sync_at ? 'accountUi.statusReady' : 'accountUi.statusPending')}</dd>
        <dt>{t('accountUi.lastSync')}</dt><dd>{date(source.last_sync_at)}</dd></dl></div>)}
  </div>;
}
export function DavAccountEditor({ account,onClose }: {account?:DavAccount;onClose:()=>void}) {
  const {t}=useTranslation();const panelId=useId(); const operation=useAccountOperation();
  const [section,setSection]=useState('general');const [error,setError]=useState('');
  const [form,setForm]=useState({name:account?.name||'',serverUrl:account?.serverUrl||'',username:account?.username||'',password:'',
    calendarEnabled:account?.calendarEnabled||false,contactsEnabled:account?.contactsEnabled||false,intervalMin:account?.intervalMin||60});
  const [discovery,setDiscovery]=useState<Discovery|null>(null);
  const [saved,setSaved]=useState(account);
  const change=<K extends keyof typeof form>(key:K,value:typeof form[K])=>{setForm(previous=>({...previous,[key]:value}));
    if (['serverUrl','username','password'].includes(key)) setDiscovery(null);};
  const discover=()=>void operation.run(async current=>{
    setError('');try {
      const result:Discovery=await api.post(account ? `/dav-accounts/${encodeURIComponent(account.id)}/discover` : '/dav-accounts/discover',
        account ? {password:form.password} : {serverUrl:form.serverUrl,username:form.username,password:form.password});
      if(!current())return;setDiscovery(result);setSection('services');
      if(!account)setForm(previous=>({...previous,calendarEnabled:result.calendarSupported,contactsEnabled:result.contactsSupported}));
    }catch(error){if(current())setError(errorKey(error));}
  });
  const save=()=>void operation.run(async current=>{
    setError('');try {
      const result:DavAccount=account ? await api.patch(`/dav-accounts/${encodeURIComponent(account.id)}`,{name:form.name,password:form.password,
        calendarEnabled:form.calendarEnabled,contactsEnabled:form.contactsEnabled,intervalMin:form.intervalMin,revision:saved?.revision}) : await api.post('/dav-accounts',form);
      if(!current())return;setSaved(result);onClose();
    }catch(error){if(current())setError(errorKey(error));}
  });
  const canDiscover=Boolean(account || (form.serverUrl.trim() && form.username.trim() && form.password));
  return <InlineEditor title={account ? account.name : t('davAccount.addTitle')} onClose={onClose} busy={operation.busy} testId="dav-account-editor"
    footer={<><Button variant="primary" disabled={operation.busy||!form.name.trim()||(!account&&!discovery)} onClick={save}>{t('common.save')}</Button><Button disabled={operation.busy} onClick={onClose}>{t('common.cancel')}</Button></>}>
    <SectionTabs label={t('davAccount.title')} panelId={panelId} active={section} onChange={setSection} tabs={[
      {id:'general',label:t('accountUi.general')},{id:'services',label:t('accountUi.services')},...(account?[{id:'diagnostics',label:t('accountUi.diagnostics')}]:[]),
    ]}/>
    {error && <Notice danger>{t(error)}</Notice>}
    <div id={panelId} role="tabpanel">
      <div className="ui-form" hidden={section!=='general'}>
        <label>{t('accountUi.connectionName')}<input value={form.name} maxLength={120} onChange={event=>change('name',event.target.value)}/></label>
        <label>{t('accountUi.serverUrl')}<input type="url" value={form.serverUrl} readOnly={Boolean(account)} maxLength={2048} onChange={event=>change('serverUrl',event.target.value)}/></label>
        <label>{t('accountUi.username')}<input value={form.username} readOnly={Boolean(account)} autoComplete="username" maxLength={320} onChange={event=>change('username',event.target.value)}/></label>
        <label>{t('accountUi.password')}<input type="password" autoComplete="new-password" value={form.password} maxLength={4096} onChange={event=>change('password',event.target.value)}/></label>
        {account&&<p className="au-note">{t('accountUi.keepPassword')}</p>}
        <Button disabled={operation.busy||!canDiscover} onClick={discover}>{t('davAccount.discover')}</Button><p className="au-note">{t('accountUi.davPolicyHint')}</p>
      </div>
      <div className="ui-form" hidden={section!=='services'}>
        {!account&&!discovery&&<Notice>{t('davAccount.discoverFirst')}</Notice>}
        <div className="au-switch-row"><strong>{t('calendar.calendars')}</strong><Switch label={t('calendar.calendars')} checked={form.calendarEnabled}
          disabled={operation.busy || !(discovery?.calendarSupported || account?.calendarSupported)} onChange={value=>change('calendarEnabled',value)}/></div>
        <div className="au-switch-row"><strong>{t('contacts.title')}</strong><Switch label={t('contacts.title')} checked={form.contactsEnabled}
          disabled={operation.busy || !(discovery?.contactsSupported || account?.contactsSupported)} onChange={value=>change('contactsEnabled',value)}/></div>
        <p className="au-note">{t('davAccount.pauseHint')}</p>
        <label>{t('accountUi.syncInterval')}<select value={form.intervalMin} onChange={event=>change('intervalMin',Number(event.target.value))}>
          {[...new Set([15,30,60,180,360,1440,form.intervalMin])].sort((a,b)=>a-b).map(minutes=><option key={minutes} value={minutes}>{t('accountUi.intervalMinutes',{count:minutes})}</option>)}</select></label>
        <Button disabled={operation.busy||!canDiscover} onClick={discover}>{t('davAccount.discover')}</Button>
      </div>
      {section==='diagnostics'&&saved&&<DavDiagnostics account={saved}/>}
    </div>
  </InlineEditor>;
}
