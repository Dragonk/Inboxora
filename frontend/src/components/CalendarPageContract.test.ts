import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const calendarPath = new URL('./CalendarPage.tsx', import.meta.url);
const sidebarPath = new URL('./CalendarSidebar.tsx', import.meta.url);
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
  // Editability is the server's `read_only`, never a comparison against the origin: a provider
  // collection the server reports as writable must be editable without a code change here.
  assert.doesNotMatch(source, /source === 'local'|source !== 'local'/);
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

test('calendar rail links to settings where owned calendars expose safe management actions', async () => {
  const [calendar, sidebar, manager] = await Promise.all([readFile(calendarPath, 'utf8'), readFile(sidebarPath, 'utf8'), readFile(new URL('./CalendarSettingsManager.tsx', import.meta.url), 'utf8')]);
  assert.doesNotMatch(calendar, /data-testid="calendar-manage-sources"/);
  assert.match(sidebar, /data-testid="calendar-sidebar-manage-sources"/);
  assert.match(sidebar, /setAdminTab\('calendar'\)/);
  assert.doesNotMatch(sidebar, /Dialog|role="menuitem"/);
  assert.match(manager, /calendar-appearance-dialog/);
  assert.match(manager, /type="color"/);
  assert.match(manager, /confirmCalendarDelete/);
  assert.match(manager, /canManageLocalCalendar\(calendar\) &&/);
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
  const dialog = await readFile(new URL('./CalendarDeleteScopeDialog.tsx', import.meta.url), 'utf8');
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

// A recurring event can be created, and a series edit must be able to change the rule.
test('the event dialog offers a recurrence rule for new events and series edits', async () => {
  const source = await readFile(calendarPath, 'utf8');
  assert.match(source, /data-testid="calendar-recurrence"/);
  assert.match(source, /const recurrenceMode = form\.mode === 'create' \|\| form\.editScope === 'series'/);
  for (const frequency of ['recurrenceNone', 'recurrenceDaily', 'recurrenceWeekly', 'recurrenceMonthly', 'recurrenceYearly']) {
    assert.match(source, new RegExp(`calendar\\.${frequency}`));
  }
  // Weekly rules pick the days; the chips use the active locale's day names.
  assert.match(source, /calendar-recurrence-weekday-options/);
  assert.match(source, /weekdayFormatter\.format/);
});

test('editing a recurring event chooses between one occurrence, the following ones, and the series', async () => {
  const source = await readFile(calendarPath, 'utf8');
  assert.match(source, /data-testid="calendar-edit-scope"/);
  // The master (with its rule) is fetched because a list row only carries an occurrence.
  assert.match(source, /api\.calendar\.getEvent\(String\(event\.series_id\)\)/);
  assert.match(source, /recurrenceFormFromStored\(/);
  assert.match(source, /const changeEditScope = \(scope: 'single' \| 'following' \| 'series'\)/);
  assert.match(source, /onEditScopeChange=\{changeEditScope\}/);
  // Three answers, each from the existing localized delete-scope strings, and each naming its own scope.
  assert.match(source, /role="radio" aria-checked=\{form\.editScope === 'single'\}/);
  assert.match(source, /role="radio" aria-checked=\{form\.editScope === 'following'\}/);
  assert.match(source, /role="radio" aria-checked=\{form\.editScope === 'series'\}/);
});

test('a series or following edit states the rule while a single-occurrence edit never touches it', async () => {
  const view = await readFile(new URL('./calendarView.ts', import.meta.url), 'utf8');
  // The payload keeps recurrenceId only for the occurrence scopes, and lets the scopes that describe a
  // remaining series carry `recurrence` (including null to clear it). A single-occurrence edit must not.
  assert.match(view, /form\.recurrenceId && form\.editScope !== 'series'/);
  assert.match(view, /form\.editScope === 'series' \|\| form\.editScope === 'following'\) && !form\.recurrencePreserve/);
  assert.match(view, /form\.editScope === 'following' \? \{ scope: 'following' \} : \{\}/);
  assert.match(view, /form\.mode === 'create'/);
});

test('the calendar API exposes the single-event read used to open a series', async () => {
  const api = await readFile(new URL('../utils/api.ts', import.meta.url), 'utf8');
  assert.match(api, /getEvent: \(id: string/);
  assert.match(api, /`\/calendar\/events\/\$\{encodeURIComponent\(id\)\}`/);
});

test('every locale translates the recurrence editor', async () => {
  const locales = (await readdir(localesPath)).filter(name => name.endsWith('.json'));
  assert.equal(locales.length, 9);
  const keys = ['recurrence', 'recurrenceNone', 'recurrenceDaily', 'recurrenceWeekly', 'recurrenceMonthly', 'recurrenceYearly', 'recurrenceIntervalLabel', 'recurrenceEndsLabel', 'recurrenceEndNever', 'recurrenceEndUntil', 'recurrenceEndCount', 'recurrenceCountLabel', 'recurrenceCustomHint', 'recurrenceReplace', 'recurrenceScope', 'recurrenceWeekdays'];
  for (const name of locales) {
    const strings = JSON.parse(await readFile(new URL(name, localesPath), 'utf8'));
    for (const key of keys) {
      assert.equal(typeof strings.calendar[key], 'string', `${name} is missing calendar.${key}`);
      assert.ok(strings.calendar[key].length > 0, `${name} has an empty calendar.${key}`);
    }
    // The custom-rule hint must interpolate with i18next syntax.
    assert.match(strings.calendar.recurrenceCustomHint, /\{\{rule\}\}/, `${name} recurrenceCustomHint has no {{rule}} placeholder`);
  }
});
