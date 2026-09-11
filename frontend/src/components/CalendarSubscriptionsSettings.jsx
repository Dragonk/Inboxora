import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { Button, inputStyle } from './ui.jsx';
import { calendarSyncWarning } from '../utils/calendarSyncWarning.js';
import { intlLocale } from '../utils/intlLocale.js';
import {
  HOLIDAY_CALENDARS,
  HOLIDAY_SYNC_INTERVAL_MIN,
  defaultHolidayCountry,
  holidayCalendarUrl,
  holidayCountryName,
  normalizeSubscriptionUrl,
} from '../utils/calendarSubscriptions.js';

// The calendar page listens for this instead of sharing React state with the settings
// modal: adding a subscription here must refresh a calendar that is already mounted
// behind the dialog, exactly like accepting an invitation from the mail reader does.
function notifyCalendarChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('inboxora:calendar-changed'));
}

export default function CalendarSubscriptionsSettings({ locale }) {
  const { t, i18n } = useTranslation();
  // The resource ids are not BCP 47 tags (zhCN), so spell them out before any Intl call.
  const language = intlLocale(locale || i18n.resolvedLanguage || i18n.language) || 'en';
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ displayName: '', url: '' });
  const [country, setCountry] = useState(() => defaultHolidayCountry(language));

  const load = useCallback(async () => {
    try {
      const result = await api.calendar.listSources();
      setSources(result.sources || []);
      setError(null);
    } catch (err) {
      setError(err.message);
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

  const addSubscription = async ({ displayName, url, intervalMin }) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.createSource({ kind: 'ical_url', displayName, url, intervalMin });
      setNotice(t('calendar.subscribeSuccess'));
      await load();
      notifyCalendarChanged();
      return true;
    } catch (err) {
      setError(err.message || t('calendar.subscribeFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitUrl = async event => {
    event.preventDefault();
    const url = normalizeSubscriptionUrl(form.url);
    if (!url) return;
    const added = await addSubscription({ displayName: form.displayName.trim(), url, intervalMin: 60 });
    if (added) setForm({ displayName: '', url: '' });
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

  const removeSource = async id => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.deleteSource(id);
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(err.message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const syncSource = async id => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.calendar.syncSource(id);
      await load();
      notifyCalendarChanged();
    } catch (err) {
      setError(err.message || t('calendar.subscribeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return <section data-testid="calendar-subscriptions-settings" style={section}>
    <div className="settings-switch-label">{t('calendar.subscribeTitle')}</div>
    <p className="settings-choice-description">{t('calendar.subscribeDescription')}</p>
    {error && <p role="alert" className="ui-alert">{error}</p>}
    {notice && <p role="status" data-testid="calendar-subscription-notice" style={success}>{notice}</p>}
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
            <Button onClick={() => syncSource(source.id)} disabled={busy}>{t('calendar.syncSource')}</Button>
            <Button variant="danger" onClick={() => removeSource(source.id)} disabled={busy}>{t('calendar.delete')}</Button>
          </span>
        </div>;
      })}
    </div>
  </section>;
}

const section = { display: 'grid', gap: 10, marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border-subtle)' };
const formStyle = { display: 'grid', gap: 10, maxWidth: 560 };
const holidayBlock = { display: 'grid', gap: 8, marginTop: 8, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)' };
const holidayRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 };
const fieldStyle = { display: 'grid', gap: 6, flex: '1 1 220px', minWidth: 0, fontSize: 12, color: 'var(--text-secondary)' };
const sourceBlock = { display: 'grid', gap: 8, marginTop: 8 };
const sourceRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8 };
const sourceText = { display: 'grid', gap: 2, minWidth: 0, overflowWrap: 'anywhere' };
const sourceActions = { display: 'flex', flexWrap: 'wrap', gap: 6 };
const success = { color: 'var(--accent)', fontSize: 12 };
