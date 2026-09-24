import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';
import { selectCalendarView } from './navigation.ts';

test('calendar desktop and mobile entry points expose the current sidebar', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/');
  await navigateModule(page, 'calendar');
  await expect(page.getByTestId('calendar-page')).toBeVisible();
  if (page.viewportSize()!.width < 768) await page.getByTestId('calendar-mobile-panel').click();
  await expect(page.getByTestId('calendar-sidebar')).toBeVisible();
  await expect(page.getByTestId('calendar-mini-month')).toBeVisible();
  if (page.viewportSize()!.width < 768) await expect(page.getByTestId('calendar-mobile-dock')).toBeVisible();
});

test('calendar sidebar groups resources and preserves selection while collapsing', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  if (page.viewportSize()!.width < 768) await page.getByTestId('calendar-mobile-panel').click();
  const sidebar = page.getByTestId('calendar-sidebar');
  const group = sidebar.getByTestId('calendar-source-group').first();
  const row = sidebar.locator('[data-resource-id="calendar-personal"]');
  const check = row.locator('input[type="checkbox"]');
  await expect(check).toBeChecked();
  const collapseRequests: unknown[] = [];
  await page.route('**/api/calendar/presentation/sources/*', route => {
    if (route.request().method() === 'PATCH') collapseRequests.push(route.request().postDataJSON());
    return route.fallback();
  });
  const toggle = group.getByTestId('calendar-source-collapse');
  await toggle.click();
  await expect.poll(() => collapseRequests.length).toBe(1);
  expect(collapseRequests[0]).toMatchObject({ collapsed: true });
  await expect(check).toBeChecked();
});

test('calendar week views render timed events and work-hour boundaries', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  for (const view of ['week', 'workweek']) {
    await selectCalendarView(page, view);
    const grid = page.getByTestId('calendar-grid');
    await expect(grid.getByRole('button', { name: /Planowanie projektu/ })).toBeVisible();
    await expect(grid.getByTestId('calendar-work-hours-boundary')).not.toHaveCount(0);
  }
});

test('calendar events expose writable actions and read-only state', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  await selectCalendarView(page, 'week');
  const event = page.getByTestId('calendar-grid').getByRole('button', { name: /Planowanie projektu/ }).first();
  await expect(event).toBeVisible();
  await event.click({ button: 'right' });
  const menu = page.getByTestId('calendar-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Edytuj wydarzenie/ })).toBeVisible();
  await page.keyboard.press('Escape');
});
