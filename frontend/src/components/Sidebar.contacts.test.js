import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('desktop Contacts navigation contract', () => {
  it('exposes Contacts as a primary desktop navigation destination', async () => {
    const sidebar = await readFile(new URL('./Sidebar.jsx', import.meta.url), 'utf8');
    const navStart = sidebar.indexOf('{/* Nav */}');
    const navEnd = sidebar.indexOf('{/* Bottom section */}', navStart);
    const primaryNav = sidebar.slice(navStart, navEnd);

    assert.match(primaryNav, /testId="contacts-nav-primary"/);
    assert.match(primaryNav, /onClick=\{\(\) => setShowContacts\(true\)\}/);
    assert.match(primaryNav, /active=\{showContacts\}/);
    assert.match(primaryNav, /\{!isMobile && \(/);
  });
});
