import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mailAppPath = new URL('./MailApp.tsx', import.meta.url);
const contactsPath = new URL('./ContactsPage.tsx', import.meta.url);
const messageListPath = new URL('./MessageList.tsx', import.meta.url);

test('mobile navigation lives in the top bar and the mock-up drawer, not a bottom bar', async () => {
  const source = await readFile(mailAppPath, 'utf8');

  assert.match(source, /function MobileTopBar\(/);
  assert.match(source, /data-testid="mobile-topbar"/);
  assert.match(source, /onMenu={\(\) => setMobileSidebarOpen\(true\)}/);
  assert.match(source, /data-testid="mobile-sidebar"[\s\S]*?zIndex: 1300/);
  assert.doesNotMatch(source, /function MobileNavigation\(/);
  assert.doesNotMatch(source, /data-testid="mobile-primary-nav"/);
  assert.match(source, /'--mobile-nav-height': '0px'/);
});

test('mobile creation controls no longer reserve bottom-bar space', async () => {
  const [mailApp, contacts, messageList] = await Promise.all([
    readFile(mailAppPath, 'utf8'),
    readFile(contactsPath, 'utf8'),
    readFile(messageListPath, 'utf8'),
  ]);

  assert.match(mailApp, /'--mobile-nav-height': '0px'/);
  assert.match(messageList, /bottom: mobileNavigationPosition === 'bottom' \? 'calc\(var\(--sab\) \+ 72px\)' : 'calc\(var\(--sab\) \+ 20px\)'/);
  assert.match(messageList, /<MobileFloatingAction inline/);
  assert.match(contacts, /data-testid="contacts-header-new"/);
  assert.match(mailApp, /position={mobileNavigationPosition}/);
});

test('mobile contact navigation invalidates stale detail requests', async () => {
  const contacts = await readFile(contactsPath, 'utf8');

  assert.match(contacts, /contactSelectionRequestRef\.current \+= 1/);
  assert.match(contacts, /requestId !== contactSelectionRequestRef\.current/);
});

test('mobile top bar and content containers respect status bar and safe-area insets', async () => {
  const [mailApp, indexCss, capConfig, mainActivity, stylesXml] = await Promise.all([
    readFile(mailAppPath, 'utf8'),
    readFile(new URL('../index.css', import.meta.url), 'utf8'),
    readFile(new URL('../../packages/capacitor.config.json', import.meta.url), 'utf8'),
    readFile(new URL('../../packages/android/app/src/main/java/io/github/dragonk/inboxora/MainActivity.java', import.meta.url), 'utf8'),
    readFile(new URL('../../packages/android/app/src/main/res/values/styles.xml', import.meta.url), 'utf8'),
  ]);

  // MobileTopBar handles both top and bottom safe-area insets
  assert.match(
    mailApp,
    /padding:\s*position === 'bottom'\s*\?\s*'4px 8px calc\(4px \+ var\(--sab\)\)'\s*:\s*'calc\(4px \+ var\(--sat\)\) 8px 4px'/
  );
  // Bottom navigation offsets top content container below status bar
  assert.match(
    mailApp,
    /mobileNavigationPosition === 'bottom' && \{\s*paddingTop:\s*'var\(--sat\)'\s*\}/
  );

  // CSS variables support Capacitor injected custom property with env fallback
  assert.match(indexCss, /--sat:\s*var\(--safe-area-inset-top,\s*env\(safe-area-inset-top,\s*0px\)\);/);
  assert.match(indexCss, /--sab:\s*var\(--safe-area-inset-bottom,\s*env\(safe-area-inset-bottom,\s*0px\)\);/);
  assert.match(indexCss, /--sal:\s*var\(--safe-area-inset-left,\s*env\(safe-area-inset-left,\s*0px\)\);/);
  assert.match(indexCss, /--sar:\s*var\(--safe-area-inset-right,\s*env\(safe-area-inset-right,\s*0px\)\);/);

  // Android Capacitor config disables default zeroing of view padding
  const config = JSON.parse(capConfig);
  assert.equal(config.plugins?.SystemBars?.insetsHandling, 'disable');

  // Native MainActivity applies window insets to android.R.id.content
  assert.match(mainActivity, /applyWindowInsetsPadding\(\)/);
  assert.match(mainActivity, /Type\.statusBars\(\) \| WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(mainActivity, /v\.setPadding\(bars\.left, bars\.top, bars\.right, 0\)/);

  // Android theme enables fitsSystemWindows
  assert.match(stylesXml, /<item name="android:fitsSystemWindows">true<\/item>/);
});
