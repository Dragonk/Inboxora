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
    assert.match(mobileLayout, /<Suspense fallback=\{lazyFallback\}><ContactsPage \/><\/Suspense>/);
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
    assert.match(mobileLayout, /<Suspense fallback=\{lazyFallback\}><CalendarPage \/><\/Suspense>/);
    assert.match(mobileLayout, /!showContacts && !showCalendar && !selectedMessageId/);
  });
});
