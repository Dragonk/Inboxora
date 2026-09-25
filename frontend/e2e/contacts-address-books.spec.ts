import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

// An address book created or imported by the user has to stay renameable — the default
// name ("Personal", "Prywatna") is rarely the one people want in their list. The API
// already accepted a rename; there was simply no way to reach it from the interface, and
// the create flow used a native window.prompt that looked nothing like the app.

async function openAddressBooks(page, testInfo) {
  await page.goto('/');
  await navigateModule(page, 'contacts');
  await page.getByTestId('contacts-manage-books').click();
  await expect(page.getByTestId('contacts-books-manager')).toBeVisible();
  await page.getByRole('tab').nth(1).click();
}

test('an address book can be renamed from the books menu', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'address book menu is a desktop contract');
  await fixtureApi; await setupV3(page);
  const patches = [];
  await page.route('**/api/contacts/address-books/**', route => {
    if (route.request().method() === 'PATCH') patches.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { id: 'book-work', name: 'Prywatne', source: 'local', visible: true } });
  });
  await openAddressBooks(page, testInfo);

  await page.locator('[data-resource-id="book-work"] button').click();

  const dialog = page.getByRole('dialog', { name: 'Ustawienia zasobu' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('Nazwa', { exact: true });
  await expect(field).toHaveValue('Firmowa');
  await field.fill('Prywatne');
  await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  // The dialog edits the name *and* the book's DAV access, so the PATCH carries both — a
  // local book's access can be narrowed or widened here, and omitting it would silently
  // leave the previous value.
  expect(patches).toEqual([{
    url: expect.stringContaining('/contacts/address-books/book-work'),
    body: { visible: true, name: 'Prywatne', davMode: 'read_write' },
  }]);
});

test('creating an address book uses the app dialog, not a native prompt', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'address book menu is a desktop contract');
  await fixtureApi; await setupV3(page);
  const created = [];
  let nativePromptUsed = false;
  page.on('dialog', async dialog => { nativePromptUsed = true; await dialog.dismiss(); });
  await page.route('**/api/contacts/address-books', route => {
    if (route.request().method() === 'POST') { created.push(route.request().postDataJSON()); return route.fulfill({ json: { id: 'book-new', name: 'Nowa', source: 'local', visible: true } }); }
    return route.fallback();
  });
  await openAddressBooks(page, testInfo);

  await page.getByRole('button', { name: /Nowa książka/ }).click();
  const dialog = page.getByTestId('contacts-book-name-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('contacts-book-name-input').fill('Nowa');
  await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  expect(created).toEqual([{ name: 'Nowa' }]);
  expect(nativePromptUsed).toBe(false);
});

test('an empty name is refused in place instead of sending a bad request', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'address book menu is a desktop contract');
  await fixtureApi; await setupV3(page);
  let posted = 0;
  await page.route('**/api/contacts/address-books', route => {
    if (route.request().method() === 'POST') { posted += 1; return route.fulfill({ json: { id: 'book-new', name: 'x', source: 'local', visible: true } }); }
    return route.fallback();
  });
  await openAddressBooks(page, testInfo);

  await page.getByRole('button', { name: /Nowa książka/ }).click();
  const dialog = page.getByTestId('contacts-book-name-dialog');
  // Whitespace is not a name: the submit stays disabled rather than firing a 400.
  await page.getByTestId('contacts-book-name-input').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Zapisz', exact: true })).toBeDisabled();
  expect(posted).toBe(0);
});

test('the manager exposes multiple address books for independent selection', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'address book manager contract is desktop-focused');
  await fixtureApi; await setupV3(page);
  await openAddressBooks(page, testInfo);
  await expect(page.locator('[data-resource-id="book-work"]')).toHaveCount(1);
  await expect(page.locator('[data-resource-id="book-private"]')).toHaveCount(1);
  await expect(page.locator('[data-resource-id="book-work"] input[type="checkbox"]')).toBeVisible();
  await expect(page.locator('[data-resource-id="book-private"] input[type="checkbox"]')).toBeVisible();
});
