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
  await page.getByRole('tab', { name: /^Services$|^Usługi$/ }).click();
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


test('native diagnostics use the mail snapshot, not an obsolete IMAP time or calendar success', async ({ page, fixtureApi }) => {
  await fixtureApi;
  page.__languageOverride = 'en';
  const account = { id: 'account-gmail', name: 'Gmail diagnostics', email_address: 'me@gmail.test',
    mail_transport: 'gmail_api', enabled: true, last_sync: '2026-09-20T15:12:00Z', sync_error: null };
  const mailAt = '2026-09-27T03:30:29Z';
  let recovered = false;
  const feature = { authorized: true, requiredScopes: [], missingScopes: [], lastErrorAt: null, cursorPresent: true };
  const push = { capability: 'available', subscription: 'active', effectiveSyncMode: 'push_and_polling', degradedReason: null,
    expiresAt: null, lastNotificationAt: null, lastErrorCode: null };
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/provider-status', route => route.fulfill({ json: {
    accountId: account.id, provider: 'google', generatedAt: '2026-09-29T08:00:00Z', snapshotRevision: recovered ? '2' : '1',
    mail: { transport: 'gmail_api', native: true, authorized: true, synchronized: true,
      syncPending: !recovered, syncErrorCode: recovered ? null : 'RESOURCE_NOT_FOUND', migrationAvailable: false },
    calendar: null, contacts: null,
    diagnostics: { accountId: account.id, provider: 'google', transport: 'gmail_api',
      connection: { provider: 'google', identity: account.email_address, status: 'active' },
      push: { mail: push, calendar: push, contacts: push },
      mail: { ...feature, transport: 'gmail_api', scheduler: 'scheduled_and_push', lastSuccessfulSync: recovered ? '2026-09-29T08:01:00Z' : mailAt,
        lastErrorCode: recovered ? null : 'RESOURCE_NOT_FOUND' },
      calendar: { ...feature, lastSuccessfulSync: '2026-09-29T07:58:09Z', lastErrorCode: null, collections: 3 },
      contacts: { ...feature, lastSuccessfulSync: '2026-09-29T07:58:07Z', lastErrorCode: null, collections: 1 },
    },
  } }));
  await page.goto('/');
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
  const displayedDate = await page.evaluate(date => new Date(date).toLocaleString(), mailAt);
  await expect(page.getByTestId('account-diagnostics-summary-sync')).toHaveText(displayedDate);
  await expect(page.getByTestId('account-diagnostics-summary-state')).toContainText('RESOURCE_NOT_FOUND');
  await expect(page.getByTestId('account-diagnostics-connection-status')).toContainText('active');
  await expect(page.getByTestId('account-diagnostics-summary')).not.toContainText('unavailable');
  recovered = true;
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
  const recoveredDate = await page.evaluate(() => new Date('2026-09-29T08:01:00Z').toLocaleString());
  await expect(page.getByTestId('account-diagnostics-summary-sync')).toHaveText(recoveredDate);
  await expect(page.getByTestId('account-diagnostics-error-mail')).toHaveCount(0);
  await expect(page.getByTestId('account-diagnostics-summary-state')).toContainText('Connected');
});
