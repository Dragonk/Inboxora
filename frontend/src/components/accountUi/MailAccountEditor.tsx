import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { api } from '../../utils/api.ts';
import { intlLocale } from '../../utils/intlLocale.ts';
import AccountProviderServices, { transportLabel } from '../AccountProviderServices.tsx';
import { Button } from '../ui.tsx';
import { Back, Header, Icon, Notice } from './AccountUi.tsx';
import { SectionTabs } from './SettingsSections.tsx';
import { openSettings, useSettingsTarget } from './navigation.ts';

interface MailAccount { id: string; name?: unknown; email_address?: string | null; mail_transport?: unknown; last_sync?: unknown; sync_error?: unknown }
export interface MailEditorFormProps<T> {
  onSave: (form: T) => Promise<void>; onComplete: () => void; onCancel: () => void;
  section: 'general' | 'servers'; showProviderServices: false; hideActions: true;
  submitRef: { current: (() => Promise<void>) | null };
  onSavingChange: (busy: boolean) => void; onErrorChange: (error: string) => void;
}
/** One draft/save boundary; moving between tabs never mounts a second form. */
export default function MailAccountEditor<T>({ account, onSave, onClose, reload, renderForm }: {
  account: MailAccount; onSave: (form: T) => Promise<void>; onClose: () => void; reload: () => void;
  renderForm: (props: MailEditorFormProps<T>) => ReactNode;
}) {
  const { t, i18n } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const [section, setSection] = useState('general'); const [serviceChanges, setServiceChanges] = useState<Partial<Record<'calendars' | 'contacts', boolean>>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = useRef<(() => Promise<void>) | null>(null); const life = useRef(0); const panelId = useId(); const submitLock = useRef(false);
  const native = account.mail_transport === 'gmail_api' || account.mail_transport === 'microsoft_graph';
  useEffect(() => { life.current++; const cancel = () => { life.current++; }; return cancel; }, [epoch, account.id]);
  useSettingsTarget('accounts', target => {
    if (target.module === 'accounts' && target.accountId === account.id && target.section) setSection(target.section === 'services' && !native ? 'servers' : target.section === 'servers' && native ? 'services' : target.section);
  });
  const close = () => { if (!busy) { setServiceChanges({}); onClose(); } };
  const save = async (form: T) => {
    const generation = life.current;
    const current = () => generation === life.current && useStore.getState().authEpoch === epoch;
    if (!current()) return;
    await onSave(form);
    if (!current()) return;
    // The metadata save can succeed before one service fails. Keep remaining intent
    // and explicitly report the partial result; retries do not flip another service.
    for (const [service, enabled] of Object.entries(serviceChanges) as Array<['calendars' | 'contacts', boolean]>) {
      try {
        await api.setAccountProviderFeature(account.id, service, enabled);
        if (!current()) return;
        setServiceChanges(values => { const next = { ...values }; delete next[service]; return next; });
      } catch { if (current()) throw new Error(t('accountUi.partialSave')); return; }
    }
  };
  const commit = async () => {
    if (submitLock.current || !submit.current || useStore.getState().authEpoch !== epoch) return;
    const generation = life.current; submitLock.current = true; setBusy(true);
    try { await submit.current(); }
    finally { submitLock.current = false; if (life.current === generation && useStore.getState().authEpoch === epoch) setBusy(false); }
  };
  const saved = () => { if (useStore.getState().authEpoch === epoch) { reload(); onClose(); } };
  const transport = typeof account.mail_transport === 'string' ? account.mail_transport : 'imap_smtp';
  const lastSync = typeof account.last_sync === 'string' && Number.isFinite(Date.parse(account.last_sync))
    ? new Intl.DateTimeFormat(intlLocale(i18n.resolvedLanguage || i18n.language), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(account.last_sync)) : t('common.never');
  return <div className="au-workspace au-mail-editor">
    <Back onClick={close}>{t('accountUi.allAccounts')}</Back>
    <SectionTabs label={t('accountUi.mailAccount')} panelId={panelId} active={section} onChange={setSection} tabs={[
      { id: 'general', label: t('accountUi.general') }, { id: native ? 'services' : 'servers', label: t(native ? 'accountUi.services' : 'accountUi.servers') }, { id: 'diagnostics', label: t('accountUi.diagnostics') },
    ]}/>
    <Header title={typeof account.name === 'string' && account.name ? account.name : t('accountUi.mailAccount')} description={account.email_address}/>
    <section id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${section}`}><fieldset disabled={busy} className="au-form-fieldset">
      <div hidden={section !== 'general' && section !== 'servers'}>{renderForm({ onSave: save, onComplete: saved, onCancel: close, section: section === 'servers' ? 'servers' : 'general', showProviderServices: false, hideActions: true, submitRef: submit, onSavingChange: setBusy, onErrorChange: setError })}</div>
      {native && <div hidden={section !== 'services'} className="au-service-detail"><AccountProviderServices accountId={account.id} reload={reload} t={t} deferServiceChanges onFeatureIntentChange={(service, enabled) => setServiceChanges(values => ({ ...values, [service]: enabled }))}/><div className="au-actions au-section"><Button onClick={() => openSettings({ module: 'calendar', section: 'resources', accountId: account.id })}><Icon name="calendar"/>{t('accountUi.calendarsOnAccount')}</Button><Button onClick={() => openSettings({ module: 'contacts', section: 'resources', accountId: account.id })}><Icon name="books"/>{t('accountUi.booksOnAccount')}</Button></div></div>}
      <div hidden={section !== 'diagnostics'} className="au-service-detail"><dl className="au-meta"><dt>{t('accountUi.transport')}</dt><dd>{transportLabel(transport)}</dd><dt>{t('accountUi.lastSync')}</dt><dd>{lastSync}</dd><dt>{t('accountUi.connectionState')}</dt><dd>{t(account.sync_error ? 'accountUi.statusFailed' : 'accountUi.statusUnknown')}</dd></dl>{native && <AccountProviderServices accountId={account.id} reload={reload} t={t} diagnosticsOnly/>}</div>
    </fieldset></section>
    {error && <Notice danger>{error === t('accountUi.partialSave') ? error : t('accountUi.operationFailed')}</Notice>}
    <div className="au-actions au-save-footer"><Button variant="primary" disabled={busy} onClick={() => void commit()}>{t(busy ? 'accountUi.saving' : 'accountUi.saveChanges')}</Button><Button disabled={busy} onClick={close}>{t('common.cancel')}</Button></div>
  </div>;
}
