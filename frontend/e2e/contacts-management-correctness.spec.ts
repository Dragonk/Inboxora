import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

async function openBooks(page: any) {
  await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: [
    { id: 'book-work', name: 'Firmowa', source: 'local', visible: true, read_only: false },
    { id: 'book-private', name: 'Prywatna', source: 'local', visible: true, read_only: false },
  ] } }));
  await navigateModule(page, 'contacts');
  await page.getByTestId('contacts-manage-books').click();
  const manager = page.getByTestId('contacts-books-manager');
  await expect(manager).toBeVisible();
  await page.getByRole('tab').nth(1).click();
  return manager;
}

test('contacts manager keeps multiple books independently selectable', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); await page.goto('/');
  const manager = await openBooks(page);
  const work = page.locator('[data-resource-id="book-work"]');
  const personal = page.locator('[data-resource-id="book-private"]');
  await expect(work).toBeVisible();
  await expect(personal).toBeVisible();
  await expect(work.locator('input[type="checkbox"]')).toBeChecked();
  await expect(personal.locator('input[type="checkbox"]')).toBeChecked();
  const updates: unknown[] = [];
  await page.route('**/api/contacts/address-books/*', route => {
    if (route.request().method() === 'PATCH') updates.push(route.request().postDataJSON());
    return route.fallback();
  });
  await personal.locator('input[type="checkbox"]').click();
  await expect.poll(() => updates.length).toBe(1);
  await work.locator('input[type="checkbox"]').click();
  await expect.poll(() => updates.length).toBe(2);
  expect(updates[0]).toMatchObject({ visible: false });
  expect(updates[1]).toMatchObject({ visible: false });
});

test('contacts manager persists a selected book and does not reroute selection', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); await page.goto('/');
  const requests: unknown[] = [];
  await page.route('**/api/contacts/address-books/*', route => {
    if (route.request().method() === 'PATCH') requests.push(route.request().postDataJSON());
    return route.fallback();
  });
  const manager = await openBooks(page);
  const work = page.locator('[data-resource-id="book-work"]');
  await work.locator('input[type="checkbox"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ visible: false });
  await expect(manager).toBeVisible();
});
