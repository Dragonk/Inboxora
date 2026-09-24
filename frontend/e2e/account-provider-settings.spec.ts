import { test, expect } from './fixtures.ts';

test('provider edits stage intent across refresh and Cancel discards it', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = { id: 'account-gmail', name: 'Provider fixture', email_address: 'me@gmail.test', mail_transport: 'gmail_api', enabled: true, color: '#4285f4' };
  let writes = 0;
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/provider-status', route => route.fulfill({ json: {
    accountId: account.id, provider: 'google',
    mail: { transport: 'gmail_api', native: true, authorized: true, migrationAvailable: false },
    calendar: { enabled: true, authorized: true, synchronized: true, connectionId: 'connection', collections: [] },
    contacts: { enabled: false, authorized: true, synchronized: true, connectionId: 'connection', collections: [] },
    diagnostics: null,
  } }));
  await page.route('**/api/accounts/account-gmail/provider-features/*', async route => {
    writes += 1;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await expect(page.getByTestId('account-summary-calendar')).toBeVisible();
  await expect(page.getByTestId('account-summary-contacts')).toBeVisible();
  await expect(page.getByTestId('account-provider-summary').getByRole('switch')).toHaveCount(0);
  await page.getByRole('button', { name: /^Edit$|^Edytuj$/ }).click();
  const calendar = page.getByTestId('account-feature-calendars');
  await expect(calendar).toHaveAttribute('aria-checked', 'true');
  await calendar.click();
  await expect(calendar).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('account-refresh').click();
  await expect(calendar).toHaveAttribute('aria-checked', 'false');
  expect(writes).toBe(0);
  await page.getByRole('button', { name: /^Cancel$|^Anuluj$/ }).click();
  await page.getByRole('button', { name: /^Edit$|^Edytuj$/ }).click();
  await expect(calendar).toHaveAttribute('aria-checked', 'true');
  expect(writes).toBe(0);
});
