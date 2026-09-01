import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar navigation preferences live in the application appearance settings', async () => {
  const [adminPanel, calendar] = await Promise.all([
    source('./AdminPanel.jsx'),
    source('./CalendarPage.jsx'),
  ]);

  assert.match(adminPanel, /data-testid="calendar-week-start-setting"/);
  assert.match(adminPanel, /data-testid="mobile-navigation-position-setting"/);
  assert.match(adminPanel, /setCalendarWeekStartsOn/);
  assert.match(adminPanel, /setMobileNavigationPosition/);
  assert.doesNotMatch(calendar, /onWeekStartsOnChange/);
  assert.doesNotMatch(calendar, /onMobileNavigationPositionChange/);
});

test('desktop calendar grid fills the application content pane', async () => {
  const calendar = await source('./CalendarPage.jsx');

  assert.match(calendar, /<CalendarGrid[^>]*isMobile=\{isMobile\}/);
  assert.match(calendar, /flex: 1, minWidth: 0/);
  assert.match(calendar, /minmax\(\$\{isMobile \? 112 : 0\}px, 1fr\)/);
});

test('external calendar management is directly discoverable from the calendar toolbar', async () => {
  const [calendar, sidebar] = await Promise.all([
    source('./CalendarPage.jsx'),
    source('./CalendarSidebar.jsx'),
  ]);

  assert.match(calendar, /data-testid="calendar-manage-sources"/);
  assert.match(calendar, /sourcePanelRequest/);
  assert.match(sidebar, /sourcePanelRequest/);
});