import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';

// An address book created or imported by the user has to stay renameable — the default
// name ("Personal", "Prywatna") is rarely the one people want in their list. The API
// already accepted a rename; there was simply no way to reach it from the interface, and
// the create flow used a native window.prompt that looked nothing like the app.

async function openAddressBooks(page, testInfo) {
  await page.goto('/');
  await navigateModule(page, 'contacts');
  if (testInfo.project.name.startsWith('chromium-mobile')) {
    await page.getByTestId('contacts-address-books').click();
  } else {
    // The book actions live behind a <details>, so open it before reaching for them.
    await page.locator('.contacts-book-menu summary').click();
  }
  await expect(page.getByTestId('contacts-address-book-select')).toBeVisible();
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

  await page.getByTestId('contacts-address-book-select').selectOption('book-work');
  await page.getByTestId('contacts-address-book-rename').click();

  const dialog = page.getByTestId('contacts-book-name-dialog');
  await expect(dialog).toBeVisible();
  const field = page.getByTestId('contacts-book-name-input');
  // The dialog opens on the current name, so renaming is an edit rather than a retype.
  await expect(field).toHaveValue('Firmowa');
  await field.fill('Prywatne');
  await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  expect(patches).toEqual([{ url: expect.stringContaining('/contacts/address-books/book-work'), body: { name: 'Prywatne' } }]);
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

  await page.getByRole('button', { name: 'Nowa książka kontaktów', exact: true }).click();
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

  await page.getByRole('button', { name: 'Nowa książka kontaktów', exact: true }).click();
  const dialog = page.getByTestId('contacts-book-name-dialog');
  // Whitespace is not a name: the submit stays disabled rather than firing a 400.
  await page.getByTestId('contacts-book-name-input').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Zapisz', exact: true })).toBeDisabled();
  expect(posted).toBe(0);
});

test('a read-only address book offers no rename', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'address book menu is a desktop contract');
  await fixtureApi; await setupV3(page);
  // A CardDAV-synced book is owned by its server; renaming it locally would be a lie.
  await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: [{ id: 'book-dav', name: 'Zespół', source: 'carddav', visible: true }] } }));
  await openAddressBooks(page, testInfo);

  await page.getByTestId('contacts-address-book-select').selectOption('book-dav');
  await expect(page.getByTestId('contacts-address-book-rename')).toHaveCount(0);
});
