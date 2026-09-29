import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

// No request may use a service worker or a live provider/backend in these regressions.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/ws**', socket => socket.close());
  await page.route('**/api/mail/scheduled**', route => route.fulfill({ json: [] }));
  await page.route('**/api/carddav', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/accounts/*/provider-status', route => route.fulfill({ json: { calendar: null, contacts: null } }));
  await page.route('**/api/accounts/*/provider-features', route => route.fulfill({ json: { calendar: null, contacts: null } }));
});

async function openBookSettings(page: Page, id: string) {
  await navigateModule(page, 'contacts');
  await page.getByTestId(page.viewportSize()!.width < 768 ? 'contacts-manage-books-mobile' : 'contacts-manage-books').click();
  const row = page.getByTestId('contacts-books-manager').locator(`[data-resource-id="${id}"]`);
  await expect(row).toBeVisible();
  return row;
}

for (const source of ['microsoft', 'carddav']) test(`${source} address book deletion requires confirmation, retains unknown outcome and checks the same intent`, async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  const deletes: { confirmName: string; idempotencyKey: string }[] = [];
  let confirmed = false;
  const capabilityReads: (string | null)[] = [];
  await page.route('**/api/contacts/address-books{,?*}', route => {
    const includeCapabilities = new URL(route.request().url()).searchParams.get('includeDeletionCapabilities');
    capabilityReads.push(includeCapabilities);
    return route.fulfill({ json: { addressBooks: confirmed ? [] : [
      { id: 'provider-book', name: 'Project contacts', source, ...(source === 'microsoft' ? { account_id: 'account-outlook' } : { dav_source_id: 'dav-source', source_username: 'dav-user' }), collection_id: 'provider-collection', visible: true, read_only: false, ...(includeCapabilities === 'true' ? { deletion: { supported: true } } : {}) },
    ] } });
  });
  await page.route('**/api/contacts/address-books/provider-book', route => {
    expect(route.request().method()).toBe('DELETE');
    deletes.push(route.request().postDataJSON());
    confirmed = deletes.length > 1;
    return route.fulfill({ status: confirmed ? 200 : 202, json: { state: confirmed ? 'confirmed' : 'outcome_unknown' } });
  });
  await page.goto('/');
  const settings = await openBookSettings(page, 'provider-book');
  expect(capabilityReads).toContain(null);
  expect(capabilityReads).toContain('true');
  await settings.getByRole('button', { name: /^Usuń zasób:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Usuń zasób', exact: true });
  await expect(dialog.getByText(/u dostawcy wraz z jego zawartością/)).toBeVisible();
  const remove = dialog.getByRole('button', { name: 'Usuń', exact: true });
  await expect(remove).toBeDisabled();
  await dialog.getByRole('textbox').fill('Project contacts');
  await expect(remove).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await remove.click();
  await expect.poll(() => deletes.length).toBe(1);
  await expect(remove).toBeDisabled();
  await expect(dialog.getByText(/Operacja zdalna nie została jeszcze potwierdzona/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Anuluj', exact: true }).click();
  await expect(page.locator('[data-resource-id="provider-book"]')).toBeVisible();
  await page.getByRole('button', { name: 'Sprawdź operację', exact: true }).click();
  await expect.poll(() => deletes.length).toBe(2);
  expect(deletes[0].confirmName).toBe('Project contacts');
  expect(deletes[0].idempotencyKey).toBeTruthy();
  expect(deletes[1]).toEqual(deletes[0]);
  await expect(page.locator('[data-resource-id="provider-book"]')).toHaveCount(0);
});

test('unsupported provider book shows a disabled delete action and the capability reason', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  await page.route('**/api/contacts/address-books{,?*}', route => route.fulfill({ json: { addressBooks: [
    { id: 'default-book', name: 'All contacts', source: 'google', account_id: 'account-gmail', collection_id: 'google-primary', visible: true, read_only: false, deletion: { supported: false, reason: 'The primary address book cannot be deleted.' } },
  ] } }));
  await page.goto('/');
  const settings = await openBookSettings(page, 'default-book');
  await expect(settings.getByRole('button', { name: /^Usuń zasób:/ })).toBeDisabled();
  await settings.locator('.au-resource-actions button').first().click();
  await expect(page.locator('.admin-panel .au-inline-editor')).toContainText("Możliwość zapisu ograniczają uprawnienia nadane u źródła. To ustawienie nie może ich rozszerzyć.");
});

test('CalDAV uses the local collection route and restores the same unresolved intent after navigation', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page);
  const deletes: { confirmName: string; idempotencyKey: string }[] = [];
  let confirmed = false;
  const capabilityReads: (string | null)[] = [];
  await page.route('**/api/calendar/calendars{,?*}', route => {
    const capability = new URL(route.request().url()).searchParams.get('includeDeletionCapabilities');
    capabilityReads.push(capability);
    return route.fulfill({ json: { calendars: confirmed ? [] : [
      { id: 'calendar-remote', name: 'DAV projects', color: '#35793a', source: 'caldav', read_only: false, ...(capability === 'true' ? { deletion: { supported: true } } : {}) },
    ] } });
  });
  await page.route('**/api/calendar/calendars/calendar-remote', route => {
    expect(route.request().method()).toBe('DELETE');
    deletes.push(route.request().postDataJSON()); confirmed = deletes.length > 1;
    return route.fulfill({ status: confirmed ? 200 : 202, json: { state: confirmed ? 'confirmed' : 'outcome_unknown' } });
  });
  const forbidden: string[] = [];
  await page.route('**/api/accounts/*/provider-calendars/**', route => { forbidden.push(route.request().url()); return route.abort(); });
  await page.route('**/api/calendar/sources/**', route => {
    if (route.request().method() === 'DELETE') { forbidden.push(route.request().url()); return route.abort(); }
    return route.fallback();
  });
  await page.goto('/');
  await navigateModule(page, 'calendar');
  if (page.viewportSize()!.width < 768) await page.getByTestId('calendar-mobile-panel').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const manager = page.getByTestId('calendar-settings-manager');
  await manager.locator('[data-resource-id="calendar-remote"]').getByRole('button', { name: /^Usuń zasób:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Usuń zasób', exact: true });
  const remove = dialog.getByRole('button', { name: 'Usuń', exact: true });
  await dialog.getByRole('textbox').fill('Wrong name');
  await dialog.getByRole('checkbox').check();
  await expect(remove).toBeDisabled();
  expect(deletes).toHaveLength(0);
  await dialog.getByRole('textbox').fill('DAV projects');
  await remove.click();
  await expect.poll(() => deletes.length).toBe(1);
  await expect(remove).toBeDisabled();
  await expect(dialog.getByText(/Operacja zdalna nie została jeszcze potwierdzona/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Anuluj', exact: true }).click();
  await expect(manager.locator('[data-resource-id="calendar-remote"]')).toBeVisible();
  // Switching settings modules unmounts the controller; the durable browser intent survives.
  await page.getByTestId('admin-tab-contacts').click();
  await page.getByTestId('admin-tab-calendar').click();
  await expect(manager.getByRole('button', { name: 'Sprawdź operację', exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Sprawdź operację', exact: true }).click();
  await expect.poll(() => deletes.length).toBe(2);
  expect(deletes[0]).toMatchObject({ confirmName: 'DAV projects' });
  expect(deletes[0].idempotencyKey).toBeTruthy();
  expect(deletes[1]).toEqual(deletes[0]);
  await expect(manager.getByRole('button', { name: 'Sprawdź operację', exact: true })).toHaveCount(0);
  await expect(manager.locator('[data-resource-id="calendar-remote"]')).toHaveCount(0);
  expect(capabilityReads).toContain(null); expect(capabilityReads).toContain('true');
  expect(forbidden).toEqual([]);
});
