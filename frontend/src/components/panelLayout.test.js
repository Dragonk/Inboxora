import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AGENDA_WIDTH_DEFAULT,
  AGENDA_WIDTH_MAX,
  AGENDA_WIDTH_MIN,
  AGENDA_WIDTH_STORAGE_KEY,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STORAGE_KEY,
  applyAgendaWidth,
  applyPanelWidth,
  beginAgendaResize,
  beginPanelResize,
  clampPanelWidth,
  persistAgendaWidth,
  persistPanelWidth,
  readAgendaWidth,
  readPanelWidth,
  savedAgendaWidth,
  savedPanelWidth,
} from '../utils/panelWidth.js';
import { applyLayout } from '../layouts.js';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const readUtil = name => readFileSync(new URL(`../utils/${name}`, import.meta.url), 'utf8');

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

let dragListeners = {};

function stubDom({ variable = '', stored = null } = {}) {
  const properties = new Map();
  if (variable) properties.set('--list-width', variable);
  const storage = new Map();
  if (stored != null) storage.set(PANEL_WIDTH_STORAGE_KEY, String(stored));
  dragListeners = {};
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (key, value) => properties.set(key, value),
        getPropertyValue: key => properties.get(key) || '',
      },
    },
    body: { style: {} },
    addEventListener: (type, handler) => { (dragListeners[type] ||= []).push(handler); },
    removeEventListener: (type, handler) => {
      dragListeners[type] = (dragListeners[type] || []).filter(item => item !== handler);
    },
  };
  globalThis.getComputedStyle = element => element.style;
  globalThis.localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  return { properties, storage };
}

function restoreDom() {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
}

test('panel width clamps to the shared resizable range', t => {
  t.after(restoreDom);
  assert.equal(clampPanelWidth(120), PANEL_WIDTH_MIN);
  assert.equal(clampPanelWidth(420), 420);
  assert.equal(clampPanelWidth(5_000), PANEL_WIDTH_MAX);
  assert.equal(clampPanelWidth('340'), 340);
  assert.equal(clampPanelWidth('nonsense'), null);
  assert.equal(clampPanelWidth(0), null);
});

test('panel width falls back from the live variable to storage to the default', t => {
  t.after(restoreDom);

  stubDom({ variable: '412px' });
  assert.equal(readPanelWidth(), 412);
  assert.equal(savedPanelWidth(), undefined);

  stubDom({ stored: 288 });
  assert.equal(readPanelWidth(), 288);

  stubDom();
  assert.equal(readPanelWidth(), PANEL_WIDTH_DEFAULT);
});

test('applying and persisting a panel width share one localStorage key', t => {
  t.after(restoreDom);
  const { properties, storage } = stubDom();

  assert.equal(applyPanelWidth(455), 455);
  assert.equal(properties.get('--list-width'), '455px');

  assert.equal(persistPanelWidth(455), 455);
  assert.equal(storage.get(PANEL_WIDTH_STORAGE_KEY), '455');
  assert.equal(savedPanelWidth(), 455);

  // An out-of-range drag is clamped before it is written anywhere.
  assert.equal(persistPanelWidth(9_999), PANEL_WIDTH_MAX);
  assert.equal(storage.get(PANEL_WIDTH_STORAGE_KEY), String(PANEL_WIDTH_MAX));
});

// Regression guard: the width write must not be the argument of an optional
// call (`onResize?.(apply(...))`), because optional chaining short-circuits the
// whole argument list and silently drops every drag.
test('a drag applies the new width even without an onResize observer', t => {
  t.after(restoreDom);
  const { properties } = stubDom({ variable: '360px' });

  const stop = beginPanelResize({ preventDefault() {}, clientX: 600 }, { edge: 'right' });
  assert.equal(typeof dragListeners.mousemove?.[0], 'function');
  dragListeners.mousemove[0]({ clientX: 640 });
  assert.equal(properties.get('--list-width'), '400px');
  stop();

  // The left-edge channel mirrors the delta, so dragging left widens it.
  const stopAgenda = beginAgendaResize({ preventDefault() {}, clientX: 900 }, { edge: 'left' });
  dragListeners.mousemove.at(-1)({ clientX: 860 });
  assert.equal(properties.get('--agenda-width'), `${AGENDA_WIDTH_DEFAULT + 40}px`);
  stopAgenda();
});

// Regression guard for the same optional-call trap, one level deeper: persistence
// used to run only as the argument of `onEnd?.(persist(...))`. No caller passes
// onEnd, so the width was applied while dragging and never written, and every
// reload snapped back to the default.
test('finishing a drag persists the width even though no caller passes onEnd', t => {
  t.after(restoreDom);
  const { storage } = stubDom({ variable: '360px' });

  const stop = beginPanelResize({ preventDefault() {}, clientX: 600 }, { edge: 'right' });
  dragListeners.mousemove[0]({ clientX: 660 });
  assert.equal(storage.get(PANEL_WIDTH_STORAGE_KEY), undefined, 'nothing is persisted mid-drag');
  dragListeners.mouseup.forEach(handler => handler({}));
  assert.equal(storage.get(PANEL_WIDTH_STORAGE_KEY), '420');
  assert.equal(savedPanelWidth(), 420);
  stop();

  // The agenda channel persists through the same path.
  const agendaStorage = stubDom().storage;
  const stopAgenda = beginAgendaResize({ preventDefault() {}, clientX: 900 }, { edge: 'left' });
  dragListeners.mousemove.at(-1)({ clientX: 840 });
  dragListeners.mouseup.forEach(handler => handler({}));
  assert.equal(agendaStorage.get(AGENDA_WIDTH_STORAGE_KEY), String(AGENDA_WIDTH_DEFAULT + 60));
  stopAgenda();
});

// A drag that is never released must not stack listeners: the next drag would then
// move the width twice per pixel.
test('mouseup releases the drag listeners', t => {
  t.after(restoreDom);
  stubDom({ variable: '360px' });
  const stop = beginPanelResize({ preventDefault() {}, clientX: 600 }, { edge: 'right' });
  assert.equal(dragListeners.mousemove.length, 1);
  assert.equal(dragListeners.mouseup.length, 1);
  dragListeners.mouseup.forEach(handler => handler({}));
  assert.equal(dragListeners.mousemove.length, 0);
  assert.equal(dragListeners.mouseup.length, 0);
  stop();
});

test('the stacked layout preset still defines the shared panel width', t => {
  t.after(restoreDom);
  const { properties } = stubDom();
  applyLayout('vertical');
  assert.equal(properties.get('--list-width'), `${PANEL_WIDTH_DEFAULT}px`);
  applyLayout('focused', 500);
  assert.equal(properties.get('--list-width'), '500px');
});

test('mail, contacts and calendar resize through the same shared handle', () => {
  const mailApp = read('MailApp.jsx');
  const contacts = read('ContactsPage.jsx');
  const calendar = read('CalendarPage.jsx');
  const ui = read('ui.jsx');

  for (const source of [mailApp, contacts, calendar]) {
    assert.match(source, /beginPanelResize/);
    assert.match(source, /PanelResizeHandle/);
  }
  // Every handle writes the same --list-width through the shared helper.
  assert.match(ui, /export function PanelResizeHandle/);
  assert.match(readUtil('panelWidth.js'), /PANEL_WIDTH_STORAGE_KEY = 'mailflow_list_width'/);
  assert.doesNotMatch(mailApp, /localStorage\.setItem\('mailflow_list_width'/);

  // Both calendar panels are resizable: the rail on the right edge (shared list
  // width) and the day agenda on its left edge (its own width).
  assert.match(calendar, /testId="calendar-rail-resize"/);
  assert.match(calendar, /testId="calendar-agenda-resize"/);
  assert.match(calendar, /beginPanelResize\(event, \{ edge: 'right' \}\)/);
  assert.match(calendar, /beginAgendaResize\(event, \{ edge: 'left' \}\)/);
});

test('calendar panels render their own widths instead of private fixed values', () => {
  const css = readFileSync(new URL('./calendar.css', import.meta.url), 'utf8');
  // The rail follows the shared list column...
  assert.match(css, /\.calendar-rail \{ width: var\(--list-width, \d+px\)/);
  // ...while the agenda keeps its dedicated, independently sized channel.
  assert.match(css, /\.calendar-agenda \{ width: var\(--agenda-width, \d+px\)/);
  assert.doesNotMatch(css, /\.calendar-agenda \{ width: var\(--list-width/);
  assert.doesNotMatch(css, /\.calendar-compact \.calendar-rail \{ width: 210px; \}/);
});

test('the day agenda keeps a width separate from the shared list column', t => {
  t.after(restoreDom);
  const { properties, storage } = stubDom();

  // Resizing the mail/contact/rail column must not move the agenda...
  assert.equal(applyPanelWidth(520), 520);
  assert.equal(properties.get('--list-width'), '520px');
  assert.equal(properties.has('--agenda-width'), false);
  assert.equal(readAgendaWidth(), AGENDA_WIDTH_DEFAULT);

  // ...and resizing the agenda must not move the shared column.
  assert.equal(applyAgendaWidth(380), 380);
  assert.equal(properties.get('--agenda-width'), '380px');
  assert.equal(properties.get('--list-width'), '520px');
  assert.equal(readPanelWidth(), 520);

  assert.equal(persistAgendaWidth(380), 380);
  assert.equal(storage.get(AGENDA_WIDTH_STORAGE_KEY), '380');
  assert.equal(storage.get(PANEL_WIDTH_STORAGE_KEY), undefined);
  assert.equal(savedAgendaWidth(), 380);

  // Its own range is enforced independently of the list column's.
  assert.equal(persistAgendaWidth(1), AGENDA_WIDTH_MIN);
  assert.equal(persistAgendaWidth(9_999), AGENDA_WIDTH_MAX);
  assert.notEqual(applyPanelWidth(AGENDA_WIDTH_DEFAULT), null);
});

test('the stacked mail list fills its column instead of a percentage of the width', () => {
  const messageList = read('MessageList.jsx');
  assert.doesNotMatch(messageList, /isColumn \? '0 0 42%'/);
  assert.match(messageList, /width: '100%',\n\s+minWidth: 0,\n\s+flex: 1,/);
});

test('narrow screens present the calendar panel and day agenda as one bottom sheet', () => {
  const calendar = read('CalendarPage.jsx');
  const uiCss = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
  assert.match(calendar, /testId="calendar-day-sheet" className="calendar-day-dialog ui-sheet"/);
  assert.match(calendar, /testId="calendar-mobile-dock" className="calendar-panel-dialog ui-sheet"/);
  assert.doesNotMatch(calendar, /ui-drawer-(left|right)/);
  assert.match(uiCss, /\.ui-dialog\.ui-sheet \{/);
  // The rail no longer renders its own close row next to the sheet header's ×.
  assert.doesNotMatch(read('CalendarSidebar.jsx'), /calendar-sidebar-close/);
});

test('a sheet can be pushed back down the screen to dismiss it', () => {
  const ui = read('ui.jsx');
  // The drag zone is the sheet header, with a grabber that invites the gesture.
  assert.match(ui, /const isSheet = className\.split/);
  assert.match(ui, /onPointerDown=\{isSheet \? sheetPointerDown : undefined\}/);
  // Move/up live on `document`, so a drag that leaves the short header still
  // resolves instead of leaving the sheet stranded mid-transform.
  assert.match(ui, /document\.addEventListener\('pointermove', onMove\)/);
  assert.match(ui, /document\.addEventListener\('pointerup', onUp\)/);
  assert.match(ui, /document\.addEventListener\('pointercancel', onCancel\)/);
  assert.match(ui, /data-testid="sheet-grabber"/);
  // Following the pointer, a distance threshold, a flick threshold and a close.
  assert.match(ui, /translateY\(\$\{active\.dy\}px\)/);
  assert.match(ui, /SHEET_DISMISS_DISTANCE/);
  assert.match(ui, /SHEET_FLICK_VELOCITY/);
  assert.match(ui, /setTimeout\(\(\) => close\.current\(\), SHEET_EXIT_MS\)/);
  assert.match(ui, /finishSheetDrag/);
  // Header controls (the ×) keep their own taps instead of starting a drag.
  assert.match(ui, /closest\?\.\('button, a, input, select, textarea, \[role="button"\]'\)/);
  const uiCss = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
  assert.match(uiCss, /\.ui-sheet-grabber \{/);
  assert.match(uiCss, /touch-action: none/);
});
