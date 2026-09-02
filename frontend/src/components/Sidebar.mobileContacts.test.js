import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('mobile Contacts navigation contract', () => {
  it('makes Contacts a drawer destination and closes the drawer when selected', async () => {
    const sidebar = await readFile(new URL('./Sidebar.jsx', import.meta.url), 'utf8');

    assert.match(sidebar, /testId="contacts-nav-mobile"/);
    assert.match(sidebar, /\{isMobile && \(/);
    assert.match(sidebar, /onClick=\{\(\) => \{\s*setShowContacts\(true\);\s*setMobileSidebarOpen\(false\);\s*\}\}/);
  });

  it('renders ContactsPage in the mobile content area when Contacts is active', async () => {
    const mailApp = await readFile(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    const mobileStart = mailApp.indexOf('{isMobile ? (');
    const desktopStart = mailApp.indexOf(') : (', mobileStart);
    const mobileLayout = mailApp.slice(mobileStart, desktopStart);

    assert.match(mobileLayout, /display: showContacts \? 'flex' : 'none'/);
    assert.match(mobileLayout, /<Suspense fallback=\{lazyFallback\}><ContactsPage isActive=\{showContacts\} \/><\/Suspense>/);
  });

  it('keeps the global drawer reachable from the Contacts list', async () => {
    const contacts = await readFile(new URL('./ContactsPage.jsx', import.meta.url), 'utf8');

    assert.match(contacts, /setMobileSidebarOpen/);
    assert.match(contacts, /data-testid="contacts-mobile-menu"/);
    assert.match(contacts, /onClick=\{\(\) => setMobileSidebarOpen\(true\)\}/);
  });
});

describe('mobile Calendar navigation contract', () => {
  it('makes Calendar a drawer destination and closes the drawer when selected', async () => {
    const sidebar = await readFile(new URL('./Sidebar.jsx', import.meta.url), 'utf8');

    assert.match(sidebar, /testId="calendar-nav-mobile"/);
    assert.match(sidebar, /onClick=\{\(\) => \{\s*setShowCalendar\(true\);\s*setMobileSidebarOpen\(false\);\s*\}\}/);
  });

  it('renders CalendarPage in the mobile content area and hides mail views while active', async () => {
    const mailApp = await readFile(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    const mobileStart = mailApp.indexOf('{isMobile ? (');
    const desktopStart = mailApp.indexOf(') : (', mobileStart);
    const mobileLayout = mailApp.slice(mobileStart, desktopStart);

    assert.match(mobileLayout, /data-testid="mobile-calendar-page"/);
    assert.match(mobileLayout, /display: showCalendar \? 'flex' : 'none'/);
    assert.match(mobileLayout, /<Suspense fallback=\{lazyFallback\}><CalendarPage isActive=\{showCalendar\} \/><\/Suspense>/);
    assert.match(mobileLayout, /!showContacts && !showCalendar && !selectedMessageId/);
  });

  it('provides an accessible in-app Back control in the mobile calendar header', async () => {
    const calendar = await readFile(new URL('./CalendarPage.jsx', import.meta.url), 'utf8');

    assert.match(calendar, /const \{ showCalendar, setShowCalendar,[\s\S]*accounts,[\s\S]*\} = useStore\(\);/);
    assert.match(calendar, /data-testid="calendar-mobile-back"/);
    assert.match(calendar, /onClick=\{\(\) => setShowCalendar\(false\)\}/);
    assert.match(calendar, /aria-label=\{t\('calendar\.back'\)\}/);
  });

  it('keeps the global drawer reachable from Calendar', async () => {
    const calendar = await readFile(new URL('./CalendarPage.jsx', import.meta.url), 'utf8');

    assert.match(calendar, /setMobileSidebarOpen/);
    assert.match(calendar, /data-testid="calendar-mobile-menu"/);
    assert.match(calendar, /onClick=\{\(\) => setMobileSidebarOpen\(true\)\}/);
  });

  it('moves the calendar header after content for bottom mobile navigation and labels its panel', async () => {
    const calendar = await readFile(new URL('./CalendarPage.jsx', import.meta.url), 'utf8');

    assert.match(calendar, /const page = \{ display: 'flex', flexDirection: 'column'/);
    assert.match(calendar, /position: 'sticky', bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\)\)'[\s\S]*order: 2/);
    assert.match(calendar, /<dialog id="calendar-mobile-panel" aria-label=\{t\('calendar\.panel'\)\}/);
    assert.match(calendar, /onClose=\{\(\) => setMobilePanelOpen\(false\)\}/);
  });
});

describe('mobile mail header contract', () => {
  it('keeps Contacts out of the top mail toolbar while retaining drawer navigation', async () => {
    const messageList = await readFile(new URL('./MessageList.jsx', import.meta.url), 'utf8');
    const sidebar = await readFile(new URL('./Sidebar.jsx', import.meta.url), 'utf8');

    assert.doesNotMatch(messageList, /\/\* Contacts \*\/[\s\S]*?\{\/\* Select \/ Cancel/);
    assert.match(sidebar, /testId="contacts-nav-mobile"/);
  });
});

describe('mobile message reader Back contract', () => {
  it('does not let a reader Back button mutate browser history directly', async () => {
    const messagePane = await readFile(new URL('./MessagePane.jsx', import.meta.url), 'utf8');

    assert.doesNotMatch(messagePane, /onClick=\{\(\) => history\.back\(\)\}/);
  });
});

describe('mobile profile editing contract', () => {
  it('renders ProfileModal outside the translated mobile drawer', async () => {
    const mailApp = await readFile(new URL('./MailApp.jsx', import.meta.url), 'utf8');

    assert.match(mailApp, /import ProfileModal from '\.\/ProfileModal\.jsx';/);
    assert.match(mailApp, /<Sidebar onEditProfile=\{\(\) => setMobileProfileOpen\(true\)\} \/>/);
    assert.match(mailApp, /\{mobileProfileOpen && <ProfileModal onClose=\{\(\) => setMobileProfileOpen\(false\)\} \/>\}/);
  });
});
