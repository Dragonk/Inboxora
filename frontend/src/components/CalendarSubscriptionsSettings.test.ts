import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar settings offer ICS/webcal subscriptions, CalDAV connection, and holiday picker', async () => {
  const [admin, component] = await Promise.all([
    source('./AdminPanel.tsx'),
    source('./CalendarSubscriptionsSettings.tsx'),
  ]);

  // The section lives in Settings → Calendar, not only in the visibility panel.
  assert.match(admin, /<CalendarSubscriptionsSettings locale=/);
  assert.match(admin, /adminTab === 'calendar' && <CalendarSettingsTab/);

  // Subscribing by URL reuses the one external-source mechanism the panel already uses.
  assert.match(component, /api\.calendar\.createSource\(\{ kind: 'ical_url'/);
  assert.match(component, /normalizeSubscriptionUrl\(form\.url\)/);
  assert.match(component, /data-testid="calendar-subscriptions-settings"/);
  assert.match(component, /data-testid="calendar-subscription-row"/);
  // Local calendars are created in the same management section, without a URL or account.
  assert.match(component, /data-testid="calendar-local-create-form"/);
  assert.match(component, /api\.calendar\.createCalendar\(\{ name, color: localCalendar\.color, displayVisible: true \}\)/);
  assert.match(admin, /section === 'appearance'/);
  assert.match(admin, /section === 'connections'/);
  // Credential-bearing CalDAV setup is a Calendar setting, not a source-manager form.
  assert.match(component, /data-testid="calendar-caldav-settings-form"/);
  assert.match(component, /kind: 'caldav'/);
  assert.match(component, /username, password: caldavForm\.password/);

  // Country presets point at the maintained Thunderbird feeds instead of a local holiday engine.
  assert.match(component, /holidayCalendarUrl\(entry\.file\)/);
  assert.match(component, /HOLIDAY_SYNC_INTERVAL_MIN/);
  assert.match(component, /calendar\.holidayName/);
  // Adding a subscription refreshes a calendar that is already mounted behind the dialog.
  assert.match(component, /inboxora:calendar-changed/);
  assert.match(component, /window\.confirm\(t\('calendar\.removeSourceConfirm'\)\)/);
  assert.match(component, /api\.calendar\.updateSource\(id, \{ enabled \}\)/);
  assert.match(component, /calendar\.pauseSource/);
  assert.match(component, /calendar\.resumeSource/);
});

test('week views stretch all-day and multi-day events across the whole day', async () => {
  const [calendar, view, css] = await Promise.all([
    source('./CalendarPage.tsx'),
    source('./calendarView.ts'),
    source('./calendar.css'),
  ]);

  // One full-height band per covered day, laid out by the pure helper.
  assert.match(calendar, /layoutAllDayEvents\(dayEventsFor\(day\), day\)/);
  assert.match(calendar, /className="calendar-allday-band"/);
  assert.match(calendar, /data-testid="calendar-allday-band"/);
  // The thin chip row above the grid is gone: that was the "small tile at the top".
  assert.doesNotMatch(calendar, /allDayCell/);
  assert.doesNotMatch(calendar, /allDayLabel/);

  // The helper reports continuations so the joining edges of a multi-day block stay square.
  assert.match(view, /export function layoutAllDayEvents/);
  assert.match(view, /export function allDayEventSegment/);
  assert.match(calendar, /continuesFrom/);
  assert.match(calendar, /continuesTo/);

  assert.match(css, /\.calendar-page \.calendar-allday-band \{/);
  assert.match(css, /height: 1440px/);
});
