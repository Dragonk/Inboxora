import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar keeps DAV persistence while exposing the shared desktop and mobile layout', async () => {
  const [page, sidebar] = await Promise.all([
    source('./CalendarPage.jsx'),
    source('./CalendarSidebar.jsx'),
  ]);

  assert.match(page, /api\.calendar\.listCalendars\(\)/);
  assert.match(page, /api\.calendar\.createEvent\(payload\)/);
  assert.match(page, /data-testid="calendar-mobile-dock"/);
  assert.match(page, /mobileNavigationPosition === 'bottom'/);
  assert.match(sidebar, /data-testid="calendar-sidebar"/);
  assert.match(sidebar, /width: 280/);
  assert.match(sidebar, /data-testid="calendar-mini-month"/);
  assert.match(sidebar, /aria-label=\{t\('calendar\.previous'\)\}/);
  assert.match(sidebar, /aria-label=\{t\('calendar\.next'\)\}/);
});
