import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = () => readFile(new URL('./CalendarSidebar.tsx', import.meta.url), 'utf8');

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

  it('keeps generic collection lifecycle controls local-only', async () => {
    const component = await source();
    assert.match(component, /const localCalendar = \(calendar: CalendarRow\) => calendar\.source === 'local'/);
    assert.match(component, /\{localCalendar\(calendar\) && <>\s*<button role="menuitem" onClick=\{\(\) => editCalendar\(calendar\)\}/);
    assert.match(component, /\{ownedCalendar\(calendar\) && <button role="menuitem" onClick=\{\(\) => deleteCalendar\(calendar\)\}/);
  });

  it('leaves closing to the one shared sheet header control', async () => {
    // The panel used to render its own "Zamknij" button next to the dialog's ×.
    // The bottom sheet header now owns the single close affordance, so the rail
    // neither renders that button nor accepts an onClose prop.
    const component = await source();
    assert.doesNotMatch(component, /calendar-sidebar-close/);
    assert.doesNotMatch(component, /canCreate, onClose/);
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

  it('offers the same non-destructive pause/resume action in the source manager', async () => {
    const component = await source();
    assert.match(component, /toggleSource\(managedExternalSource, !managedExternalSource\.enabled\)/);
    assert.match(component, /calendar\.pauseSource/);
    assert.match(component, /calendar\.resumeSource/);
  });

  it('confirms source removal before deleting imported calendar projections', async () => {
    const component = await source();
    assert.match(component, /window\.confirm\(t\('calendar\.removeSourceConfirm'\)\)/);
    assert.match(component, /deleteSource\(id\); clearSourcePoll\(id\);/);
  });

  it('groups sources by presentation category without merging their durable identities', async () => {
    const component = await source();
    assert.match(component, /function calendarSourceCategory/);
    assert.match(component, /category: calendarSourceCategory\(group\)/);
    assert.match(component, /data-testid="calendar-source-category"/);
    assert.match(component, /calendarSourceCategoryKey\(group\.category\)/);
  });

  it('loads canonical groups on first entry and renders durable headings before children', async () => {
    const component = await source();
    assert.match(component, /useEffect\(\(\) => \{ void loadPresentation\(\); \}, \[\]\)/);
    assert.match(component, /presentationRequestGeneration/);
    assert.match(component, /data-testid="calendar-source-group"/);
    assert.match(component, /data-testid="calendar-source-heading"/);
    assert.match(component, /\(presentation\?\.groups \?\? \[\]\)\.map\(group/);
    assert.match(component, /group\.identityLabel/);
    assert.match(component, /view\.sidebarHidden \|\| group\.collapsed/);
  });

  it('keeps collapse separate from event selection and restores hidden calendars', async () => {
    const component = await source();
    assert.match(component, /updateSourcePresentation\(sourceId, collapsed\)/);
    assert.match(component, /data-testid="calendar-hidden-calendars"/);
    assert.match(component, /data-testid="calendar-restore-hidden"/);
    assert.match(component, /selectedBeforeHide\.current\.set\(calendar\.id, priorSelection\)/);
    assert.match(component, /selectedBeforeHide\.current\.get\(calendar\.id\) === true/);
    assert.match(component, /data-testid="calendar-source-collapse"/);
    assert.match(component, /view\.sidebarHidden \|\| group\.collapsed \? null/);
  });

  it('uses one selectable source list and lazy ICS-only add-source form in the manager', async () => {
    const [component, css] = await Promise.all([source(), readFile(new URL('./calendar.css', import.meta.url), 'utf8')]);
    assert.match(component, /data-testid="calendar-source-manager"/);
    assert.match(component, /data-testid="calendar-manager-source"/);
    assert.match(component, /data-testid="calendar-source-details"/);
    assert.match(component, /data-testid="calendar-add-source"/);
    assert.match(component, /\{showAddSource && <form/);
    assert.match(component, /data-testid="calendar-source-search"/);
    assert.match(component, /kind: 'ical_url', \.\.\.form/);
    assert.doesNotMatch(component, /form\.username|form\.password|value="caldav"/);
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /calendar-source-manager/);
  });

  it('syncs only the selected provider account with neutral localized copy', async () => {
    const [component, en, pl] = await Promise.all([
      source(),
      readFile(new URL('../locales/en.json', import.meta.url), 'utf8'),
      readFile(new URL('../locales/pl.json', import.meta.url), 'utf8'),
    ]);
    assert.match(component, /syncAccountProviderFeature\(source\.accountId, 'calendars'\)/);
    assert.match(component, /data-testid="calendar-account-sync"/);
    assert.doesNotMatch(component, /providerCalendars\.sync\(/);
    assert.doesNotMatch(component, /calendar\.googleSyncing/);
    for (const locale of [en, pl]) {
      assert.match(locale, /"providerSyncing"/);
      assert.match(locale, /"providerSyncDone"/);
      assert.match(locale, /"providerSyncPartial"/);
    }
  });

  it('lets the owner choose the per-collection DAV access mode', async () => {
    const component = await source();
    assert.match(component, /data-testid="calendar-dav-mode"/);
    for (const mode of ['off', 'read_only', 'read_write']) {
      assert.match(component, new RegExp(`value="${mode}"`));
    }
    // The dialog sends the chosen mode (and defaults to the stored one), so an
    // unrelated rename never silently resets the sharing policy.
    assert.match(component, /davMode: changes\.davMode \?\? davModeOf\(calendar\.dav_mode\)/);
    assert.match(component, /davMode: davModeOf\(calendar\.dav_mode\) \}/);
    assert.match(component, /calendar\.davAccess/);
  });
});
