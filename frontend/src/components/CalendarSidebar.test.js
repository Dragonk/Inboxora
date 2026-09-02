import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = () => readFile(new URL('./CalendarSidebar.jsx', import.meta.url), 'utf8');

describe('CalendarSidebar contract', () => {
  it('provides a mini-month, visible calendar toggles, and source management entry point', async () => {
    const component = await source();
    assert.match(component, /data-testid="calendar-mini-month"/);
    assert.match(component, /data-testid="calendar-mini-month-previous"/);
    assert.match(component, /data-testid="calendar-mini-month-next"/);
    assert.match(component, /onShiftMonth\?\.\(-1\)/);
    assert.match(component, /onShiftMonth\?\.\(1\)/);
    assert.match(component, /data-testid="calendar-visibility-toggle"/);
    assert.match(component, /data-testid="calendar-sidebar-manage-sources"/);
  });

  it('provides an explicit close action when rendered in the mobile dialog', async () => {
    const component = await source();
    assert.match(component, /onClose/);
    assert.match(component, /data-testid="calendar-sidebar-close"/);
  });

  it('keeps application-wide calendar preferences out of the calendar source panel', async () => {
    const component = await source();
    assert.doesNotMatch(component, /calendar\.firstDayOfWeek/);
    assert.doesNotMatch(component, /calendar\.mobileNavigation/);
  });

  it('waits for the asynchronous initial source sync with a bounded, cancellable poll', async () => {
    const component = await source();
    assert.match(component, /lastSyncAt|lastError/);
    assert.match(component, /setTimeout/);
    assert.match(component, /clearTimeout/);
    assert.match(component, /unmount|mounted|cancel/i);
    assert.match(component, /const maxAttempts = 70/);
    assert.match(component, /attempts >= maxAttempts/);
    assert.match(component, /pending\.clear\(\)/);
  });

  it('guards independent source-panel requests across cleanup and unmount', async () => {
    const component = await source();
    assert.match(component, /let active = true/);
    assert.match(component, /!active \|\| !mounted\.current/);
    assert.match(component, /return \(\) => \{ active = false; \}/);
  });

  it('cancels pending initial-sync polling after a successful source deletion', async () => {
    const component = await source();
    assert.match(component, /deleteSource\(id\); clearSourcePoll\(id\);/);
  });
});
