import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar settings offer an ICS/webcal subscription form and a holiday picker', async () => {
  const [admin, component] = await Promise.all([
    source('./AdminPanel.jsx'),
    source('./CalendarSubscriptionsSettings.jsx'),
  ]);

  // The section lives in Settings → Calendar, not only in the visibility panel.
  assert.match(admin, /<CalendarSubscriptionsSettings locale=/);
  assert.match(admin, /adminTab === 'calendar' && <CalendarSettingsTab/);

  // Subscribing by URL reuses the one external-source mechanism the panel already uses.
  assert.match(component, /api\.calendar\.createSource\(\{ kind: 'ical_url'/);
  assert.match(component, /normalizeSubscriptionUrl\(form\.url\)/);
  assert.match(component, /data-testid="calendar-subscriptions-settings"/);
  assert.match(component, /data-testid="calendar-subscription-row"/);

  // Country presets point at the maintained Thunderbird feeds instead of a local holiday engine.
  assert.match(component, /holidayCalendarUrl\(entry\.file\)/);
  assert.match(component, /HOLIDAY_SYNC_INTERVAL_MIN/);
  assert.match(component, /calendar\.holidayName/);
  // Adding a subscription refreshes a calendar that is already mounted behind the dialog.
  assert.match(component, /inboxora:calendar-changed/);
});

test('week views stretch all-day and multi-day events across the whole day', async () => {
  const [calendar, view, css] = await Promise.all([
    source('./CalendarPage.jsx'),
    source('./calendarView.js'),
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
