import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const calendarPath = new URL('./CalendarPage.jsx', import.meta.url);
const sidebarPath = new URL('./CalendarSidebar.jsx', import.meta.url);
const localesPath = new URL('../locales/', import.meta.url);

test('calendar starts in month view and keeps mobile controls clear of primary navigation', async () => {
  const source = await readFile(calendarPath, 'utf8');

  assert.match(source, /const \[view, setView\] = useState\('month'\)/);
  assert.match(source, /zhCN: 'zh-CN'/);
  assert.match(source, /data-testid="calendar-mobile-dock"/);
  assert.match(source, /data-testid="calendar-mobile-new-event"/);
  assert.match(source, /bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 20px\)'/);
  assert.match(source, /bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\)\)'/);
  assert.match(source, /isMobile && !mobilePanelOpen && <button data-testid="calendar-mobile-new-event"/);
});

test('calendar exposes mini-month controls and a 280px desktop sidebar', async () => {
  const [calendar, sidebar] = await Promise.all([
    readFile(calendarPath, 'utf8'),
    readFile(sidebarPath, 'utf8'),
  ]);

  assert.match(calendar, /onShiftMonth=\{shiftMiniMonth\}/);
  assert.match(sidebar, /data-testid="calendar-sidebar"/);
  assert.match(sidebar, /data-testid="calendar-mini-month"/);
  assert.match(sidebar, /data-testid="calendar-mini-month-previous"/);
  assert.match(sidebar, /data-testid="calendar-mini-month-next"/);
  assert.match(sidebar, /const panel = \{ width: 280,/);
});

test('calendar page owns the full shell width and only mounts its active surface', async () => {
  const [calendar, mailApp] = await Promise.all([
    readFile(calendarPath, 'utf8'),
    readFile(new URL('./MailApp.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(calendar, /const page = \{[^\n]*width: '100%'[^\n]*maxWidth: 'none'/);
  assert.match(calendar, /const calendarContent = \{[^\n]*width: '100%'/);
  assert.match(mailApp, /showCalendar && <div data-testid="desktop-calendar-page"/);
  assert.match(mailApp, /showCalendar && <div data-testid="mobile-calendar-page"/);
  assert.doesNotMatch(mailApp, /Keep all three mounted/);
});

test('every locale declares a single effective calendar dictionary', async () => {
  const files = (await readdir(localesPath)).filter(name => name.endsWith('.json'));
  for (const file of files) {
    const source = await readFile(new URL(file, localesPath), 'utf8');
    assert.equal(source.match(/^ {2}"calendar"\s*:/gm)?.length, 1, file);
  }
});
