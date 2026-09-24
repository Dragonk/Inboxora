import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { calendarSidebarGroups, canManageLocalCalendar, setCalendarSidebarHidden, type CalendarPresentationSource } from './calendarSettingsModel.ts';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

describe('calendar sidebar contracts', () => {
  it('keeps navigation and visibility actions in the rail', async () => {
    const source = await read('CalendarSidebar.tsx');
    for (const id of ['calendar-sidebar', 'calendar-mini-month', 'calendar-sidebar-manage-sources']) assert.match(source, new RegExp(`data-testid="${id}"`));
    assert.match(source, /openSettings/);
    assert.match(source, /onToggleCalendar/);
  });
  it('groups durable identities without merging accounts', () => {
    const source = (id: string, kind: string): CalendarPresentationSource => ({ id, kind, label: id, accountId: kind === 'google' ? id : null, identityLabel: null, collapsed: false, featureEnabled: true, canSync: true });
    const view = (id: string, sourceId: string) => ({ id, sourceId, displayName: id, readOnly: false, selected: true, sidebarHidden: true });
    const groups = calendarSidebarGroups({ groups: [{ ...source('google-b', 'google'), calendars: [view('b', 'google-b')] }, { ...source('local', 'local'), calendars: [view('a', 'local')] }, { ...source('google-a', 'google'), calendars: [] }] }, [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(new Set(groups.map(group => group.id)), new Set(['local', 'google-a', 'google-b']));
    assert.equal(groups.flatMap(group => group.rows).find(row => row.view.id === 'a')?.view.sidebarHidden, true);
  });
  it('persists only sidebar visibility and propagates failures', async () => {
    const writes: unknown[] = []; const update = async (id: string, hidden: boolean) => { writes.push({ id, sidebarHidden: hidden }); };
    await setCalendarSidebarHidden(update, 'calendar', true); assert.deepEqual(writes, [{ id: 'calendar', sidebarHidden: true }]);
    await assert.rejects(setCalendarSidebarHidden(async () => { throw new Error('denied'); }, 'calendar', false), /denied/);
  });
  it('only local owned writable calendars are manageable', () => {
    assert.equal(canManageLocalCalendar({ id: 'local', source: 'local', owner_user_id: 'u' }), true);
    assert.equal(canManageLocalCalendar({ id: 'remote', source: 'google', owner_user_id: 'u' }), false);
    assert.equal(canManageLocalCalendar({ id: 'readonly', source: 'local', owner_user_id: 'u', read_only: true }), false);
  });
});
