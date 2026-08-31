import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

describe('mobile system Back navigation contract', () => {
  it('uses the Inboxora Android bridge name and dismisses every top-level in-app layer before exiting', async () => {
    const app = await source('./MailApp.jsx');
    const activity = await source('../../packages/android/app/src/main/java/io/github/dragonk/inboxora/MainActivity.java');

    assert.match(app, /window\.__inboxoraHandleAndroidBack\s*=/);
    assert.doesNotMatch(app, /window\.__mailflowHandleAndroidBack/);
    assert.match(activity, /window\.__inboxoraHandleAndroidBack/);

    for (const branch of [
      'closeCompose()',
      'setShowAdmin(false)',
      'setPaletteOpen(false)',
      'setShowShortcutHelp(false)',
      'setMobileSidebarOpen(false)',
      'setShowContacts(false)',
      'setShowCalendar(false)',
      'setConversationId(null)',
      'setSelectedMessage(null)',
    ]) {
      assert.ok(app.includes(branch), `missing Back behavior: ${branch}`);
    }
  });

  it('uses one Inboxora history-state namespace for the mobile PWA guard and detail entry', async () => {
    const app = await source('./MailApp.jsx');

    assert.match(app, /history\.pushState\(\{ inboxora: 'message' \}/);
    assert.match(app, /history\.pushState\(\{ inboxora: 'guard' \}/);
    assert.doesNotMatch(app, /history\.state\?\.mailflow/);
    assert.match(app, /matchMedia\?\.\('\(display-mode: standalone\)'\)\.matches/);
  });

  it('gives active nested mobile views first chance to consume Back', async () => {
    const [app, contacts, calendar, compose] = await Promise.all([
      source('./MailApp.jsx'),
      source('./ContactsPage.jsx'),
      source('./CalendarPage.jsx'),
      source('./ComposeModal.jsx'),
    ]);

    assert.match(app, /new CustomEvent\('inboxora:back', \{ cancelable: true \}\)/);
    assert.match(contacts, /addEventListener\('inboxora:back'/);
    assert.match(contacts, /event\.preventDefault\(\)/);
    assert.match(calendar, /addEventListener\('inboxora:back'/);
    assert.match(calendar, /event\.preventDefault\(\)/);
    assert.match(compose, /addEventListener\('inboxora:back'/);
    assert.match(compose, /handleCloseRef\.current\(\)/);
  });
});
