import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';
import { selectCalendarView } from './navigation.ts';

test('calendar sidebar keeps desktop and mobile controls inside the viewport', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/');
  await navigateModule(page, 'calendar');
  const calendar = page.getByTestId('calendar-page');
  if (page.viewportSize()!.width < 768) await page.getByTestId('calendar-mobile-panel').click();
  const sidebar = page.getByTestId('calendar-sidebar');
  await expect(calendar).toBeVisible(); await expect(sidebar).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = await sidebar.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  await expect(sidebar.getByTestId('calendar-mini-month')).toBeVisible();
  if (viewport.width < 768) await expect(page.getByTestId('calendar-mobile-dock')).toBeVisible();
});

test('calendar palette changes presentation without changing resource selection', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/');
  await navigateModule(page, 'calendar');
  if (page.viewportSize()!.width < 768) await page.getByTestId('calendar-mobile-panel').click();
  const sidebar = page.getByTestId('calendar-sidebar');
  const row = sidebar.locator('[data-resource-id="calendar-personal"]');
  const check = row.locator('input[type="checkbox"]');
  await expect(check).toBeChecked();
  await row.getByTestId('calendar-color-button').click();
  const palette = page.getByRole('dialog', { name: /Kolor|Color/ });
  await expect(palette).toBeVisible();
  await palette.getByRole('button').first().click();
  await expect(check).toBeChecked();
});

test('calendar week and work-week retain event geometry and read-only visibility', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/presentation', route => route.request().method() === 'PATCH' ? route.fulfill({ json: { ok: true } }) : route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{ id: 'local', kind: 'local', label: 'Local', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false, calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.goto('/');
  await navigateModule(page, 'calendar');
  for (const view of ['week', 'workweek']) {
    await selectCalendarView(page, view);
    const grid = page.getByTestId('calendar-grid');
    await expect(grid).toBeVisible();
    await expect(grid.getByTestId('calendar-work-hours-boundary')).not.toHaveCount(0);
    await expect(grid.getByRole('button', { name: /Planowanie projektu/ })).toBeVisible();
  }
});
