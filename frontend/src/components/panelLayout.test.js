import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STORAGE_KEY,
  applyPanelWidth,
  clampPanelWidth,
  persistPanelWidth,
  readPanelWidth,
  savedPanelWidth,
} from '../utils/panelWidth.js';
import { applyLayout } from '../layouts.js';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const readUtil = name => readFileSync(new URL(`../utils/${name}`, import.meta.url), 'utf8');

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

function stubDom({ variable = '', stored = null } = {}) {
  const properties = new Map();
  if (variable) properties.set('--list-width', variable);
  const storage = new Map();
  if (stored != null) storage.set(PANEL_WIDTH_STORAGE_KEY, String(stored));
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (key, value) => properties.set(key, value),
        getPropertyValue: key => properties.get(key) || '',
      },
    },
  };
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

  // Both calendar panels are resizable: the rail on the right edge, the day
  // agenda on its left edge so dragging outward widens it.
  assert.match(calendar, /testId="calendar-rail-resize"/);
  assert.match(calendar, /testId="calendar-agenda-resize"/);
  assert.match(calendar, /edge: 'right'/);
  assert.match(calendar, /edge: 'left'/);
});

test('calendar panels render the shared width instead of private fixed widths', () => {
  const css = readFileSync(new URL('./calendar.css', import.meta.url), 'utf8');
  assert.match(css, /\.calendar-rail \{ width: var\(--list-width, \d+px\)/);
  assert.match(css, /\.calendar-agenda \{ width: var\(--list-width, \d+px\)/);
  assert.doesNotMatch(css, /\.calendar-compact \.calendar-rail \{ width: 210px; \}/);
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
