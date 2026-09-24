import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.ts';
import { Button, Dialog } from '../ui.tsx';
import { Notice } from './AccountUi.tsx';
import { useAccountOperation } from './useAccounts.ts';
type DuplicateMode = 'separate' | 'merge' | 'skip';
export interface DavSource {
  dupMode?: DuplicateMode;
  id: string; label?: string | null; serverUrl?: string; username?: string;
  intervalMin?: number; lastSyncAt?: string | null; lastError?: string | null;
  bookCount?: number | null; contactCount?: number | null; connected?: boolean;
}
export default function DavSourceEditor({ kind, source, onClose, onChanged }: { kind: 'carddav' | 'caldav'; source?: DavSource; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const { t } = useTranslation(); const { busy, failed, run } = useAccountOperation();
  const [form, setForm] = useState({ label: source?.label ?? '', url: source?.serverUrl ?? '', username: source?.username ?? '', password: '', dupMode: (source?.dupMode ?? 'separate') as DuplicateMode, interval: source?.intervalMin ?? 60 });
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const save = () => void run(async current => {
    if (kind === 'carddav') {
      if (source) await api.carddav.update({ sourceId: source.id, label: form.label.trim(), dupMode: form.dupMode, intervalMin: form.interval, ...(form.password ? { password: form.password } : {}) });
      else await api.carddav.connect({ label: form.label.trim(), serverUrl: form.url.trim(), username: form.username.trim(), password: form.password, dupMode: form.dupMode, intervalMin: form.interval });
    } else if (source) await api.calendar.updateSource(source.id, { displayName: form.label.trim(), intervalMin: form.interval, ...(form.password ? { password: form.password } : {}) });
    else await api.calendar.createSource({ kind: 'caldav', displayName: form.label.trim(), url: form.url.trim(), username: form.username.trim(), password: form.password, intervalMin: form.interval });
    if (!current()) return; await onChanged(); if (current()) onClose();
  });
  return <Dialog title={t(source ? 'accountUi.editConnection' : 'accountUi.addAccount')} closeLabel={t('common.close')} onClose={onClose} busy={busy} footer={<><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant="primary" disabled={busy || !form.label.trim() || (!source && (!form.url.trim() || !form.username.trim() || !form.password))} onClick={save}>{t(source ? 'common.save' : 'accountUi.connect')}</Button></>}>
    <div className="au-workspace ui-form">
      {failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}
      <label>{t('accountUi.connectionName')}<input value={form.label} maxLength={120} disabled={busy} onChange={event => set('label', event.target.value)}/></label>
      <label>{t('accountUi.serverUrl')}{source && !form.url ? <span className="au-readonly-value">{t('accountUi.savedSecurely')}</span> : <input type="url" value={form.url} disabled={busy} readOnly={Boolean(source)} onChange={event => set('url', event.target.value)}/>}</label>
      {(!source || form.username) && <label>{t('accountUi.username')}<input value={form.username} disabled={busy} readOnly={Boolean(source)} autoComplete="username" onChange={event => set('username', event.target.value)}/></label>}
      <label>{t('accountUi.password')}<input type="password" value={form.password} disabled={busy} autoComplete="new-password" onChange={event => set('password', event.target.value)}/></label>
      {source && <p className="au-note">{t('accountUi.keepPassword')}</p>}
      <label>{t('accountUi.syncInterval')}<select value={form.interval} disabled={busy} onChange={event => set('interval', Number(event.target.value))}>{[15,30,60,180,360,1440].map(minutes => <option key={minutes} value={minutes}>{t('accountUi.intervalMinutes', { count: minutes })}</option>)}</select></label>
      {kind === 'carddav' && <label>{t('accountUi.duplicateHandling')}<select value={form.dupMode} disabled={busy} onChange={event => set('dupMode', event.target.value === 'merge' || event.target.value === 'skip' ? event.target.value : 'separate')}><option value="separate">{t('accountUi.duplicateSeparate')}</option><option value="merge">{t('accountUi.duplicateMerge')}</option><option value="skip">{t('accountUi.duplicateSkip')}</option></select></label>}
      <p className="au-note">{t('accountUi.davPolicyHint')}</p>
    </div>
  </Dialog>;
}
