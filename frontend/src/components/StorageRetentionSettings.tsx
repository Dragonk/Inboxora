import {useEffect,useId,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useStore} from '../store/index.ts';
import {api} from '../utils/api.ts';
import {Button,inputStyle} from './ui.tsx';

const keys = ['mail_body_cache_days','dav_history_days','dav_history_max_entries','auth_log_days',
  'conversation_audit_days','resolved_ingest_error_days','completed_outbox_payload_days'] as const;
type Key = typeof keys[number];
type Values = Record<Key,string>;
interface Response {values:Record<Key,number>;fields:Record<Key,{min:number;max:number;default:number}>;dataMaintenancePaused:boolean}
function isInteger(value:string,min:number,max:number) {
  return /^(0|[1-9][0-9]{0,5})$/.test(value) && Number(value)>=min && Number(value)<=max;
}
function RetentionEditor({userId,epoch}:{userId:string;epoch:number}) {
  const {t}=useTranslation(),id=useId();
  const copy: Record<Key,{label:string;hint:string}> = {
    mail_body_cache_days: {label:t('admin.retention.mail_body_cache_days'),hint:t('admin.retention.mail_body_cache_days_hint')},
    dav_history_days: {label:t('admin.retention.dav_history_days'),hint:t('admin.retention.dav_history_days_hint')},
    dav_history_max_entries: {label:t('admin.retention.dav_history_max_entries'),hint:t('admin.retention.dav_history_max_entries_hint')},
    auth_log_days: {label:t('admin.retention.auth_log_days'),hint:t('admin.retention.auth_log_days_hint')},
    conversation_audit_days: {label:t('admin.retention.conversation_audit_days'),hint:t('admin.retention.conversation_audit_days_hint')},
    resolved_ingest_error_days: {label:t('admin.retention.resolved_ingest_error_days'),hint:t('admin.retention.resolved_ingest_error_days_hint')},
    completed_outbox_payload_days: {label:t('admin.retention.completed_outbox_payload_days'),hint:t('admin.retention.completed_outbox_payload_days_hint')},
  };
  const alive=useRef(false),serial=useRef(0);
  const [reload,setReload]=useState(0),[config,setConfig]=useState<Response|null>(null);
  const [values,setValues]=useState<Values|null>(null),[original,setOriginal]=useState<Values|null>(null);
  const [loadingError,setLoadingError]=useState(false),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState(false);
  const current=()=>{const state=useStore.getState();return alive.current && state.authEpoch===epoch && state.user?.id===userId && state.user.isAdmin;};
  useEffect(()=>{
    alive.current=true;let cancelled=false;setLoadingError(false);setConfig(null);
    void api.admin.getRetention().then((data:Response)=>{
      const state=useStore.getState();if(cancelled||state.authEpoch!==epoch||state.user?.id!==userId||!state.user.isAdmin)return;
      const form={} as Values;
      for(const key of keys){
        const spec=data.fields?.[key],value=String(data.values?.[key]);
        if(!spec||!isInteger(value,spec.min,spec.max))throw new Error('Invalid retention settings response');
        form[key]=value;
      }
      setConfig(data);setValues(form);setOriginal(form);
    }).catch(()=>{const state=useStore.getState();if(!cancelled&&state.authEpoch===epoch&&state.user?.id===userId&&state.user.isAdmin)setLoadingError(true);});
    return()=>{cancelled=true;alive.current=false;};
  },[userId,epoch,reload]);
  const valid=Boolean(values&&config&&keys.every(key=>isInteger(values[key],config.fields[key].min,config.fields[key].max)));
  const dirty=Boolean(values&&original&&keys.some(key=>values[key]!==original[key]));
  const save=async()=>{
    if(!current()||!valid||!dirty||!values||!original||saving)return;
    const own=++serial.current,submitted={...values};
    const patch=Object.fromEntries(keys.filter(key=>submitted[key]!==original[key]).map(key=>[key,Number(submitted[key])]));
    setSaving(true);setSaved(false);setError(false);
    try{await api.admin.updateRetention(patch);if(!current()||serial.current!==own)return;setOriginal(submitted);setSaved(true);}
    catch{if(current()&&serial.current===own)setError(true);}
    finally{if(current()&&serial.current===own)setSaving(false);}
  };
  return <section data-testid="storage-retention-settings" aria-labelledby={`${id}-title`} style={{marginTop:32,borderTop:'1px solid var(--border)',paddingTop:24}}>
    <h2 id={`${id}-title`} style={{fontSize:17,fontWeight:600}}>{t('admin.retention.title')}</h2>
    <p className="settings-choice-description">{t('admin.retention.description')}</p>
    <p className="settings-choice-description" data-testid="retention-cache-safety">{t('admin.retention.cacheSafety')}</p>
    {loadingError?<div role="alert"><p>{t('admin.retention.loadError')}</p><Button onClick={()=>setReload(n=>n+1)}>{t('common.retry')}</Button></div>:
      !config||!values?<p role="status">{t('common.loading')}</p>:<form onSubmit={event=>{event.preventDefault();void save();}}>
      {keys.map(key=>{
        const spec=config.fields[key],invalid=!isInteger(values[key],spec.min,spec.max);
        return <div key={key} style={{margin:'18px 0'}}>
          <label htmlFor={`${id}-${key}`} className="settings-choice-label">{copy[key].label}</label>
          <div style={{margin:'6px 0',display:'flex',alignItems:'center',gap:10}}><input id={`${id}-${key}`} data-testid={`retention-${key}`} type="number" inputMode="numeric" min={spec.min} max={spec.max} step={1}
            value={values[key]} disabled={saving} aria-invalid={invalid} aria-describedby={`${id}-${key}-hint`}
            onChange={event=>{setValues({...values,[key]:event.target.value});setSaved(false);setError(false);}}
            style={{...inputStyle,width:135,maxWidth:'100%'}}/><small style={{color:'var(--text-secondary)'}}>{spec.min}–{spec.max}</small></div>
          <p id={`${id}-${key}-hint`} className="settings-choice-description">{copy[key].hint}</p>
        </div>;
      })}
      <p className="settings-choice-description">{t('admin.retention.policy')}</p>
      <p className="settings-choice-description">{t('admin.retention.docker')}</p>
      {config.dataMaintenancePaused&&<p role="status">{t('admin.retention.paused')}</p>}
      {!valid&&<p role="alert">{t('admin.retention.invalid')}</p>}
      {error&&<p role="alert">{t('admin.retention.saveError')}</p>}
      <Button type="submit" disabled={!valid||!dirty||saving}>{saving?t('common.saving'):t('common.save')}</Button>
      {saved&&<p role="status" data-testid="retention-saved">{t('admin.retention.saved')}</p>}
    </form>}
  </section>;
}
export default function StorageRetentionSettings(){
  const user=useStore(s=>s.user),epoch=useStore(s=>s.authEpoch);
  if(!user?.isAdmin||!user.id)return null;
  return <RetentionEditor key={`${epoch}:${user.id}`} userId={user.id} epoch={epoch}/>;
}
