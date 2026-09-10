import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar preferences have their own tab and mobile navigation is global', async () => {
  const [adminPanel, calendar] = await Promise.all([
    source('./AdminPanel.jsx'),
    source('./CalendarPage.jsx'),
  ]);

  assert.match(adminPanel, /testId="calendar-week-start-setting"/);
  assert.match(adminPanel, /testId="mobile-navigation-position-setting"/);
  assert.match(adminPanel, /adminTab === 'calendar' && <CalendarSettingsTab/);
  assert.match(adminPanel, /setCalendarWeekStartsOn/);
  assert.match(adminPanel, /setMobileNavigationPosition/);
  assert.doesNotMatch(calendar, /onWeekStartsOnChange/);
  assert.doesNotMatch(calendar, /onMobileNavigationPositionChange/);
});


test('external calendar management is directly discoverable from the calendar visibility panel', async () => {
  const [calendar, sidebar] = await Promise.all([
    source('./CalendarPage.jsx'),
    source('./CalendarSidebar.jsx'),
  ]);

  assert.doesNotMatch(calendar, /data-testid="calendar-manage-sources"/);
  assert.match(sidebar, /data-testid="calendar-sidebar-manage-sources"/);
  assert.match(sidebar, /sourcePanelRequest/);
});