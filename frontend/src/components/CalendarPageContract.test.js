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

// Deleting part of a series is three different operations, not one, so it cannot be a yes/no
// confirmation. Until this existed the interface could only ever remove a single occurrence:
// there was no way to remove an entire series, and none to stop one from a date onward.
test('deleting a recurring event asks which part of the series to remove', async () => {
  const source = await readFile(calendarPath, 'utf8');
  // A recurring event must open the chooser instead of confirming.
  assert.match(source, /if \(event\.recurring && event\.recurrence_id\) \{ setDeleteTarget\(target\); return; \}/);
  assert.match(source, /<CalendarDeleteScopeDialog/);
  assert.match(source, /onSelect=\{scope => performDelete\(deleteTarget, scope\)\}/);
  // The edit dialog deletes only what it opened, which for a series is one occurrence.
  assert.match(source, /if \(form\.recurrenceId\) \{ setDeleteTarget\(target\); return; \}/);
});

test('each delete scope maps to the request that matches its meaning', async () => {
  const source = await readFile(calendarPath, 'utf8');
  // 'all' removes the event outright and therefore carries no recurrenceId, which is the path
  // that also notifies invited attendees. 'following' ends the series at this occurrence.
  assert.match(source, /scope === 'all' \? undefined : target\.recurrenceId/);
  assert.match(source, /scope === 'following' \? 'following' : undefined/);
});

test('the scope chooser offers exactly the three meanings and nothing else', async () => {
  const dialog = await readFile(new URL('./CalendarDeleteScopeDialog.jsx', import.meta.url), 'utf8');
  assert.match(dialog, /data-testid="calendar-delete-scope-single"/);
  assert.match(dialog, /data-testid="calendar-delete-scope-following"/);
  assert.match(dialog, /data-testid="calendar-delete-scope-all"/);
  assert.match(dialog, /onSelect\('single'\)/);
  assert.match(dialog, /onSelect\('following'\)/);
  assert.match(dialog, /onSelect\('all'\)/);
});

test('every locale explains the three delete scopes', async () => {
  const locales = (await readdir(localesPath)).filter(name => name.endsWith('.json'));
  assert.equal(locales.length, 9);
  for (const name of locales) {
    const strings = JSON.parse(await readFile(new URL(name, localesPath), 'utf8'));
    for (const key of ['deleteRecurringTitle', 'deleteRecurringBody', 'deleteScopeSingle', 'deleteScopeFollowing', 'deleteScopeAll']) {
      assert.equal(typeof strings.calendar[key], 'string', `${name} is missing calendar.${key}`);
      assert.ok(strings.calendar[key].length > 0, `${name} has an empty calendar.${key}`);
    }
  }
});
