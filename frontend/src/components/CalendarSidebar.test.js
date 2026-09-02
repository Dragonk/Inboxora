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
});
