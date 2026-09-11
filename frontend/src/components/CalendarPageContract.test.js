import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const calendarPath = new URL('./CalendarPage.jsx', import.meta.url);
const sidebarPath = new URL('./CalendarSidebar.jsx', import.meta.url);
const localesPath = new URL('../locales/', import.meta.url);

test('calendar events expose context-menu invocation without per-event action buttons', async () => {
  const source = await readFile(calendarPath, 'utf8');
  assert.match(source, /onContextMenu=\{event => \{ event\.preventDefault\(\)/);
  assert.match(source, /keyboardEvent\.key !== 'ContextMenu'/);
  assert.match(source, /keyboardEvent\.shiftKey && keyboardEvent\.key === 'F10'/);
  // The ⋮ button was redundant: tapping an event already reaches edit and delete
  // through the preview, so no per-event action button may come back.
  assert.doesNotMatch(source, /data-testid="calendar-event-actions"/);
  assert.doesNotMatch(source, /eventActionButton/);
  // The context menu itself stays available (right-click / Shift+F10 / long-press).
  assert.match(source, /<CalendarContextMenu/);
  assert.match(source, /source === 'local'/);
  assert.match(source, /<TimeGrid[^>]*openContextMenu=\{openContextMenu\}/);
  assert.match(source, /allDayEvents[\s\S]*onContextMenu/);
});

test('time grid re-anchors on a view change without resetting same-view manual scrolling', async () => {
  const source = await readFile(calendarPath, 'utf8');
  assert.match(source, /<TimeGrid[^>]*view=\{view\}/);
  assert.match(source, /function TimeGrid\([^)]*view[^)]*\)/);
  assert.match(source, /\}, \[calendarWorkHoursEnd, calendarWorkHoursStart, view\]\)/);
});

test('calendar renders one event dialog for an active form', async () => {
  const source = await readFile(calendarPath, 'utf8');
  assert.equal(source.match(/\{form && <EventDialog/g)?.length, 1);
});

test('calendar source management stays in the visibility panel and owned calendars expose safe actions', async () => {
  const [calendar, sidebar] = await Promise.all([readFile(calendarPath, 'utf8'), readFile(sidebarPath, 'utf8')]);
  assert.doesNotMatch(calendar, /data-testid="calendar-manage-sources"/);
  assert.match(sidebar, /data-testid="calendar-sidebar-manage-sources"/);
  assert.match(sidebar, /role="menuitem"/);
  assert.match(sidebar, /calendar-appearance-dialog/);
  assert.match(sidebar, /type="color"/);
  assert.match(sidebar, /confirmCalendarDelete/);
  assert.match(sidebar, /source === 'local' && !calendar\.read_only/);
});


test('every locale declares a single effective calendar dictionary', async () => {
  const files = (await readdir(localesPath)).filter(name => name.endsWith('.json'));
  for (const file of files) {
    const source = await readFile(new URL(file, localesPath), 'utf8');
    assert.equal(source.match(/^ {2}"calendar"\s*:/gm)?.length, 1, file);
  }
});
