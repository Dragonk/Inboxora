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
