import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calendarSidebarGroups, canManageLocalCalendar, setCalendarSidebarHidden, type CalendarPresentationSource } from './calendarSettingsModel.ts';

const source = () => readFile(new URL('./CalendarSidebar.tsx', import.meta.url), 'utf8');
const manager = () => readFile(new URL('./CalendarSettingsManager.tsx', import.meta.url), 'utf8');

describe('calendar rail and canonical settings management', () => {
  it('keeps mini-month and event selection in the rail but navigates management to Accounts', async () => {
    const component = await source();
    for (const id of ['calendar-mini-month', 'calendar-mini-month-previous', 'calendar-mini-month-next', 'calendar-visibility-toggle', 'calendar-sidebar-manage-sources']) assert.ok(component.includes(`data-testid="${id}"`));
    assert.match(component, /setAdminTab\('calendar'\)/);
    assert.match(component, /setShowAdmin\(true\)/);
    assert.doesNotMatch(component, /Dialog|deleteCalendar|createSource|updateCalendarPresentation|setCollectionWriteBack/);
    assert.match(component, /onToggleCalendar\(calendar.id\)/);
  });

  it('groups durable identities without merging same-provider accounts or hiding selected events', () => {
    const source = (id: string, kind: string): CalendarPresentationSource => ({ id, kind, label: id, accountId: kind === 'google' ? id : null, identityLabel: null, collapsed: false, featureEnabled: true, canSync: true });
    const view = (id: string, sourceId: string) => ({ id, sourceId, displayName: id, readOnly: false, selected: true, sidebarHidden: true });
    const groups = calendarSidebarGroups({ groups: [
      { ...source('google-b', 'google'), calendars: [view('b', 'google-b')] },
      { ...source('local', 'local'), calendars: [view('a', 'local')] },
      { ...source('google-a', 'google'), calendars: [] },
    ] }, [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(groups.map(group => group.id), ['local', 'google-a', 'google-b']);
    assert.equal(groups[0].rows[0].view.selected, true);
    assert.equal(groups[0].rows[0].view.sidebarHidden, true);
  });

  it('hide/show persists only sidebarHidden and preserves failures', async () => {
    const writes: unknown[] = [];
    const update = async (id: string, hidden: boolean) => { writes.push({ id, sidebarHidden: hidden }); };
    await setCalendarSidebarHidden(update, 'selected-calendar', true);
    await setCalendarSidebarHidden(update, 'selected-calendar', false);
    assert.deepEqual(writes, [{ id: 'selected-calendar', sidebarHidden: true }, { id: 'selected-calendar', sidebarHidden: false }]);
    await assert.rejects(setCalendarSidebarHidden(async () => { throw new Error('denied'); }, 'a', true), /denied/);
    const component = await manager();
    assert.match(component, /setCalendarSidebarHidden\(api.calendar.updateCalendarPresentation, calendar.id, !view.sidebarHidden\)/);
    assert.doesNotMatch(component, /onToggleCalendar|visibleCalendarIds|selectedBeforeHide|updatePreferences/);
  });

  it('permits collection lifecycle changes only for writable owned local calendars', () => {
    assert.equal(canManageLocalCalendar({ id: 'local', source: 'local', owner_user_id: 'u' }), true);
    for (const source of ['google', 'microsoft', 'ical_url', 'caldav', 'system']) assert.equal(canManageLocalCalendar({ id: source, source, owner_user_id: 'u', read_only: false }), false);
    assert.equal(canManageLocalCalendar({ id: 'readonly', source: 'local', owner_user_id: 'u', read_only: true }), false);
    assert.equal(canManageLocalCalendar({ id: 'unowned', source: 'local' }), false);
  });

  it('retains source/account controls, local DAV policy and ICS import in settings', async () => {
    const component = await manager();
    assert.match(component, /syncAccountProviderFeature\(source.accountId, 'calendars'\)/);
    assert.doesNotMatch(component, /providerCalendars.sync/);
    assert.match(component, /window.confirm\(t\('calendar.removeSourceConfirm'\)\)/);
    assert.match(component, /intervalMin/);
    assert.match(component, /calendar.pauseSource/);
    assert.match(component, /calendar.resumeSource/);
    assert.match(component, /canManageLocalCalendar\(calendar\) &&/);
    assert.match(component, /CalendarSubscriptionsSettings locale=\{locale\} creationOnly/);
    for (const mode of ['off', 'read_only', 'read_write']) assert.ok(component.includes(`value="${mode}"`));
    assert.match(component, /api.calendar.importIcs/);
    assert.match(component, /setTimeout/);
    assert.match(component, /clearTimeout/);
    assert.match(component, /< 70/);
  });

  it('fences refreshes and async management against session change and unmount', async () => {
    const component = await manager();
    assert.match(component, /useStore.getState\(\).authEpoch === authEpoch/);
    assert.match(component, /lifetime.current === generation/);
    assert.match(component, /if \(!current\(\)\) return/);
    assert.match(component, /request !== requests.current/);
    const rail = await source();
    assert.match(rail, /active && request === generation.current/);
    assert.match(rail, /window.removeEventListener\('inboxora:calendar-changed'/);
  });
});
