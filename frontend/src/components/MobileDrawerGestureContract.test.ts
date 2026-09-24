import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mailAppPath = new URL('./MailApp.tsx', import.meta.url);
const adminPanelPath = new URL('./AdminPanel.tsx', import.meta.url);
const useSwipeRowPath = new URL('../hooks/useSwipeRow.ts', import.meta.url);
const storePath = new URL('../store/index.ts', import.meta.url);

test('the drawer gesture is owned by one coordinator on the mobile content surface', async () => {
  const source = await readFile(mailAppPath, 'utf8');

  // One owner: the coordinator hook is wired to the content surface and drawer.
  assert.match(source, /useMobileDrawerGesture\(\{/);
  assert.match(source, /surfaceRef: mobileContentRef/);
  assert.match(source, /drawerRef: mobileDrawerRef/);
  assert.match(source, /enabled: mobileSidebarSwipeEnabled/);
  assert.match(source, /<div ref=\{mobileContentRef\}/);
  assert.match(source, /ref=\{mobileDrawerRef\}/);

  // The old inline sidebar touch handlers must not compete with the coordinator.
  assert.doesNotMatch(source, /sidebarDragRef/);

  // The reader keeps native text selection out of the drawer's zone.
  assert.match(source, /data-ce-reader-pane="true" data-mobile-gesture-ignore="true"/);
});

test('row swipe and drawer share one arbiter', async () => {
  const swipeRow = await readFile(useSwipeRowPath, 'utf8');

  assert.match(swipeRow, /isRowGestureSuppressed/);
  assert.match(swipeRow, /setRowGestureSuppressed\(false\)/);
});

test('the drawer preference lives next to the mobile navigation position', async () => {
  const [adminPanel, store] = await Promise.all([
    readFile(adminPanelPath, 'utf8'),
    readFile(storePath, 'utf8'),
  ]);

  // Same settings block as the top/bottom choice.
  assert.match(adminPanel, /testId="mobile-navigation-position-setting"[\s\S]{0,1500}testId="mobile-sidebar-swipe-setting"/);
  assert.match(adminPanel, /t\('admin\.appearance\.mobileSidebarSwipe'\)/);
  const choices = adminPanel.match(/<SettingsChoices\b[\s\S]*?\/>/g)?.find(block => block.includes('testId="mobile-sidebar-swipe-setting"'));
  assert.ok(choices, 'the gesture uses the shared two-option choice control');
  assert.match(choices, /value=\{mobileSidebarSwipeEnabled \? 'on' : 'off'\}/);
  assert.match(choices, /onChange=\{value => setMobileSidebarSwipeEnabled\(value === 'on'\)\}/);
  assert.match(choices, /\['off', t\('conversation\.readerOff'\), t\('admin\.appearance\.mobileSidebarSwipeOffDesc'\)\]/);
  assert.match(choices, /\['on', t\('conversation\.readerOn'\), t\('admin\.appearance\.mobileSidebarSwipeOnDesc'\)\]/);
  assert.equal(choices.match(/\['(?:off|on)',/g)?.length, 2);

  // Defaults to on, and only an explicit stored boolean flips it.
  assert.match(store, /mobileSidebarSwipeEnabled: true/);
  assert.match(store, /typeof prefs\.mobileSidebarSwipeEnabled === 'boolean'/);
});
