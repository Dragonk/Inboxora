import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import CalendarSettingsManager from '../CalendarSettingsManager.tsx';
import ContactsPage from '../ContactsPage.tsx';
import { useStore } from '../../store/index.ts';
import { useSettingsTarget } from './navigation.ts';
import './accountUi.css';

export interface SectionTab { id: string; label: ReactNode }
/** Shared tab grammar, matching Appearance/Rules. Contents retain their draft state. */
export function SectionTabs({ tabs, active, onChange, label, panelId }: {
  tabs: readonly SectionTab[]; active: string; onChange: (id: string) => void; label: string; panelId: string;
}) {
  return <div role="tablist" aria-label={label} className="au-tabs">
    {tabs.map(tab => <button key={tab.id} id={`${panelId}-tab-${tab.id}`} type="button" role="tab" aria-selected={active === tab.id} aria-controls={panelId} tabIndex={active === tab.id ? 0 : -1}
      onClick={() => onChange(tab.id)} onKeyDown={event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); const index = tabs.findIndex(item => item.id === tab.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const parent = event.currentTarget.parentElement; onChange(tabs[next].id);
        requestAnimationFrame(() => parent?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus());
      }}>{tab.label}</button>)}
  </div>;
}
type ServiceSection = 'accounts' | 'resources' | 'import';
function sectionOf(value: string): ServiceSection { return value === 'resources' || value === 'import' ? value : 'accounts'; }
export function CalendarAccountsSettings() {
  const { t, i18n } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const [section, setSection] = useState<ServiceSection>('accounts'); const id = useId();
  useSettingsTarget('calendar', target => { if (target.module === 'calendar') setSection(target.section); });
  return <div className="au-workspace"><SectionTabs label={t('accountUi.calendarAccounts')} panelId={id} active={section} onChange={value => setSection(sectionOf(value))} tabs={[
    { id: 'accounts', label: t('accountUi.accounts') }, { id: 'resources', label: t('accountUi.calendars') }, { id: 'import', label: t('accountUi.importSubscriptions') },
  ]}/><section id={id} role="tabpanel" aria-labelledby={`${id}-tab-${section}`}><CalendarSettingsManager key={epoch} locale={i18n.resolvedLanguage || i18n.language} view={section}/></section></div>;
}
export function ContactAccountsSettings() {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const [section, setSection] = useState<ServiceSection>('accounts'); const id = useId();
  useSettingsTarget('contacts', target => { if (target.module === 'contacts') setSection(target.section); });
  return <div className="au-workspace"><SectionTabs label={t('accountUi.contactAccounts')} panelId={id} active={section} onChange={value => setSection(sectionOf(value))} tabs={[
    { id: 'accounts', label: t('accountUi.accounts') }, { id: 'resources', label: t('accountUi.books') }, { id: 'import', label: t('accountUi.importExport') },
  ]}/><section id={id} role="tabpanel" aria-labelledby={`${id}-tab-${section}`}><ContactsPage key={epoch} settingsOnly settingsSection={section}/></section></div>;
}
