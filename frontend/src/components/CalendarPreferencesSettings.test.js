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
  assert.match(calendar, /minmax\(\$\{isMobile && !month \? 112 : 0\}px, 1fr\)/);
  assert.match(calendar, /style=\{\{ \.\.\.page, \.\.\.\(isMobile \? mobilePage : \{\}\) \}\}/);
  assert.match(calendar, /const page = \{[^\n]*overflow: 'auto'/);
  assert.match(calendar, /const mobilePage = \{ overflowX: 'hidden', paddingBottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 12px\)' \}/);
  assert.match(calendar, /\.\.\.\(isMobile \? mobileToolbar : \{\}\)/);
  assert.match(calendar, /const mobileToolbar = \{ flexBasis: '100%', width: '100%' \}/);
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