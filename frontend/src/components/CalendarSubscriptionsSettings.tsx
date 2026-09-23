import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.ts';
import { Button, inputStyle } from './ui.tsx';
import { calendarSyncWarning } from '../utils/calendarSyncWarning.ts';
import { intlLocale } from '../utils/intlLocale.ts';
import { toAppError } from '../utils/errors.ts';
import {
  HOLIDAY_CALENDARS,
  HOLIDAY_SYNC_INTERVAL_MIN,
  defaultHolidayCountry,
  holidayCalendarUrl,
  holidayCountryName,
  normalizeSubscriptionUrl,
} from '../utils/calendarSubscriptions.ts';

// The calendar page listens for this instead of sharing React state with the settings
// modal: adding a subscription here must refresh a calendar that is already mounted
// behind the dialog, exactly like accepting an invitation from the mail reader does.
function notifyCalendarChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('inboxora:calendar-changed'));
}

interface CalendarSource {
  id: string;
  displayName?: string;
  kind?: string;
  intervalMin?: number;
  lastError?: string | null;
  lastSyncAt?: string | null;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCalendarSource(value: unknown): value is CalendarSource {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  return (value.displayName === undefined || typeof value.displayName === 'string')
    && (value.kind === undefined || typeof value.kind === 'string')
    && (value.intervalMin === undefined || typeof value.intervalMin === 'number')
    && (value.lastError === undefined || value.lastError === null || typeof value.lastError === 'string')
    && (value.lastSyncAt === undefined || value.lastSyncAt === null || typeof value.lastSyncAt === 'string');
}

function calendarSources(value: unknown): CalendarSource[] {
  if (!isRecord(value) || !Array.isArray(value.sources)) return [];
  return value.sources.filter(isCalendarSource);
}

export default function CalendarSubscriptionsSettings({ locale }: { locale?: string }) {
  const { t, i18n } = useTranslation();
  // The resource ids are not BCP 47 tags (zhCN), so spell them out before any Intl call.
  const language = intlLocale(locale || i18n.resolvedLanguage || i18n.language) || 'en';
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: '', url: '' });
  const [localCalendar, setLocalCalendar] = useState({ name: '', color: '#3b82f6' });
  // Credentials belong to the Calendar settings connection flow. The source
  // manager can then manage discovered collections without becoming a login UI.
  const [caldavForm, setCaldavForm] = useState({ displayName: '', url: '', username: '', password: '' });
  const [country, setCountry] = useState(() => defaultHolidayCountry(language));

  const load = useCallback(async () => {
    try {
      const result = await api.calendar.listSources();
      setSources(calendarSources(result));
      setError(null);
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Localized country names come from Intl.DisplayNames, so the option list stays
  // language-aware without a translated country table in every locale file.
  const countries = useMemo(() => HOLIDAY_CALENDARS
    .map(entry => ({ ...entry, name: holidayCountryName(entry.code, language) }))
    .sort((a, b) => a.name.localeCompare(b.name, language)), [language]);

  const submitLocalCalendar = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = localCalendar.name.trim();
    if (!name) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.createCalendar({ name, color: localCalendar.color, displayVisible: true });
      setLocalCalendar({ name: '', color: '#3b82f6' });
      setNotice(t('calendar.createLocalCalendar'));
      notifyCalendarChanged();
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const addSubscription = async ({ displayName, url, intervalMin }: { displayName: string; url: string; intervalMin: number }) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.createSource({ kind: 'ical_url', displayName, url, intervalMin });
      setNotice(t('calendar.subscribeSuccess'));
      await load();
      notifyCalendarChanged();
      return true;
    } catch (err) {
      setError(toAppError(err).message || t('calendar.subscribeFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = normalizeSubscriptionUrl(form.url);
    if (!url) return;
    const added = await addSubscription({ displayName: form.displayName.trim(), url, intervalMin: 60 });
    if (added) setForm({ displayName: '', url: '' });
  };

  const submitCalDav = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = caldavForm.displayName.trim();
    const url = caldavForm.url.trim();
    const username = caldavForm.username.trim();
    if (!displayName || !url || !username || !caldavForm.password) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.createSource({
        kind: 'caldav', displayName, url, username, password: caldavForm.password, intervalMin: 60,
      });
      setCaldavForm({ displayName: '', url: '', username: '', password: '' });
      setNotice(t('calendar.subscribeSuccess'));
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(toAppError(err).message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const addHolidays = async () => {
    const entry = countries.find(item => item.code === country);
    if (!entry) return;
    await addSubscription({
      displayName: t('calendar.holidayName', { country: entry.name }),
      url: holidayCalendarUrl(entry.file),
      intervalMin: HOLIDAY_SYNC_INTERVAL_MIN,
    });
  };

  const removeSource = async (id: string) => {
    if (!window.confirm(t('calendar.removeSourceConfirm'))) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.deleteSource(id);
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(toAppError(err).message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = async (id: string, enabled: boolean) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.updateSource(id, { enabled });
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(toAppError(err).message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const syncSource = async (id: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.syncSource(id);
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(toAppError(err).message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return <section data-testid="calendar-subscriptions-settings" style={section}>
    <div className="settings-switch-label">{t('calendar.subscribeTitle')}</div>
    <p className="settings-choice-description">{t('calendar.subscribeDescription')}</p>
    {error && <p role="alert" className="ui-alert">{error}</p>}
    {notice && <p role="status" data-testid="calendar-subscription-notice" style={success}>{notice}</p>}
    <form data-testid="calendar-local-create-form" onSubmit={submitLocalCalendar} style={formStyle}>
      <div className="settings-switch-label">{t('calendar.localCalendar')}</div>
      <label style={fieldStyle}>{t('calendar.sourceName')}
        <input required maxLength={120} value={localCalendar.name} onChange={event => setLocalCalendar(current => ({ ...current, name: event.target.value }))} style={inputStyle} />
      </label>
      <label style={fieldStyle}>{t('calendar.calendarColor')}
        <input required type="color" value={localCalendar.color} onChange={event => setLocalCalendar(current => ({ ...current, color: event.target.value }))} style={{ ...inputStyle, minHeight: 38 }} />
      </label>
      <div><Button type="submit" variant="primary" disabled={busy || !localCalendar.name.trim()}>{t('calendar.createLocalCalendar')}</Button></div>
    </form>
    <form onSubmit={submitUrl} style={formStyle}>
      <label style={fieldStyle}>{t('calendar.sourceName')}
        <input required maxLength={120} value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} style={inputStyle} />
      </label>
      <label style={fieldStyle}>{t('calendar.sourceUrl')}
        <input required type="url" placeholder="https://example.com/calendar.ics" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} style={inputStyle} />
      </label>
      <span className="settings-choice-description">{t('calendar.subscribeHint')}</span>
      <div><Button type="submit" variant="primary" disabled={busy || !form.displayName.trim() || !form.url.trim()}>{t('calendar.subscribeAdd')}</Button></div>
    </form>
    <form data-testid="calendar-caldav-settings-form" onSubmit={submitCalDav} style={holidayBlock}>
      <div className="settings-switch-label">{t('calendar.caldav')}</div>
      <p className="settings-choice-description">{t('calendar.sourceUsername')} / {t('calendar.sourcePassword')}</p>
      <div style={holidayRow}>
        <label style={fieldStyle}>{t('calendar.sourceName')}
          <input required maxLength={120} value={caldavForm.displayName} onChange={event => setCaldavForm(current => ({ ...current, displayName: event.target.value }))} style={inputStyle} />
        </label>
        <label style={fieldStyle}>{t('calendar.sourceUrl')}
          <input required type="url" placeholder="https://calendar.example.com/dav" value={caldavForm.url} onChange={event => setCaldavForm(current => ({ ...current, url: event.target.value }))} style={inputStyle} />
        </label>
      </div>
      <div style={holidayRow}>
        <label style={fieldStyle}>{t('calendar.sourceUsername')}
          <input required autoComplete="username" value={caldavForm.username} onChange={event => setCaldavForm(current => ({ ...current, username: event.target.value }))} style={inputStyle} />
        </label>
        <label style={fieldStyle}>{t('calendar.sourcePassword')}
          <input required type="password" autoComplete="new-password" value={caldavForm.password} onChange={event => setCaldavForm(current => ({ ...current, password: event.target.value }))} style={inputStyle} />
        </label>
      </div>
      <div><Button type="submit" variant="primary" disabled={busy || !caldavForm.displayName.trim() || !caldavForm.url.trim() || !caldavForm.username.trim() || !caldavForm.password}>{t('calendar.addSource')}</Button></div>
    </form>
    <div style={holidayBlock}>
      <div className="settings-switch-label">{t('calendar.holidayTitle')}</div>
      <p className="settings-choice-description">{t('calendar.holidayDescription')}</p>
      <div style={holidayRow}>
        <label style={fieldStyle}>{t('calendar.holidayCountry')}
          <select value={country} onChange={event => setCountry(event.target.value)} style={inputStyle}>
            {countries.map(entry => <option key={entry.code} value={entry.code}>{entry.name}</option>)}
          </select>
        </label>
        <div><Button disabled={busy} onClick={addHolidays}>{t('calendar.holidayAdd')}</Button></div>
      </div>
    </div>
    <div style={sourceBlock}>
      <div className="settings-switch-label">{t('calendar.subscribeExisting')}</div>
      {!loading && !sources.length && <p className="settings-choice-description">{t('calendar.subscribeEmpty')}</p>}
      {sources.map(source => {
        const warning = calendarSyncWarning(source.lastError);
        const status = warning ? t('calendar.syncFailed') : (source.lastSyncAt ? t('calendar.sourceReady') : t('calendar.sourceSyncing'));
        return <div key={source.id} data-testid="calendar-subscription-row" style={sourceRow}>
          <span style={sourceText}>
            <strong>{source.displayName}</strong>
            <small>{source.kind === 'caldav' ? t('calendar.caldav') : t('calendar.icsWebcal')} &middot; {status}</small>
          </span>
          <span style={sourceActions}>
            <Button onClick={() => toggleSource(source.id, !source.enabled)} disabled={busy}>{source.enabled ? t('calendar.pauseSource') : t('calendar.resumeSource')}</Button>
             <Button onClick={() => syncSource(source.id)} disabled={busy || !source.enabled}>{t('calendar.syncSource')}</Button>
            <Button variant="danger" onClick={() => removeSource(source.id)} disabled={busy}>{t('calendar.delete')}</Button>
          </span>
        </div>;
      })}
    </div>
  </section>;
}

const section: CSSProperties = { display: 'grid', gap: 10, marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border-subtle)' };
const formStyle: CSSProperties = { display: 'grid', gap: 10, maxWidth: 560 };
const holidayBlock: CSSProperties = { display: 'grid', gap: 8, marginTop: 8, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)' };
const holidayRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 };
const fieldStyle: CSSProperties = { display: 'grid', gap: 6, flex: '1 1 220px', minWidth: 0, fontSize: 12, color: 'var(--text-secondary)' };
const sourceBlock: CSSProperties = { display: 'grid', gap: 8, marginTop: 8 };
const sourceRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8 };
const sourceText: CSSProperties = { display: 'grid', gap: 2, minWidth: 0, overflowWrap: 'anywhere' };
const sourceActions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };
const success: CSSProperties = { color: 'var(--accent)', fontSize: 12 };
