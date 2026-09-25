import { test, expect } from './fixtures.ts';

// The connector card had no browser coverage: no spec referenced the integrations status, the
// card or its sub-tabs, so a green suite said nothing about the interface this work changed.
// This drives it from the payload it renders and the two things a user can do there.
async function openIntegrations(page) {
  await page.getByTestId('sidebar-user-menu').click();
  await page.getByText('Ustawienia', { exact: true }).first().click();
  const panel = page.locator('.admin-panel');
  await panel.locator('.admin-tab').filter({ hasText: /^Integracje$/ }).click();
  await panel.getByText('Dostawcy poczty e-mail', { exact: true }).click();
  return panel;
}

const STATUS = {
  microsoft: {
    configured: true, enabled: true, mailPolicy: 'required',
    browser: { ready: true, missing: [] },
    graph: { ready: true, missing: [] },
    deviceCode: { supported: true, ready: true },
    connections: [{ id: 'conn-ms', providerUserId: 'ms-user', status: 'active' }],
  },
  google: {
    configured: true, enabled: true, mailPolicy: 'recommended',
    browser: { ready: true, missing: [] },
    deviceCode: { supported: false, ready: false, reason: 'not_supported' },
    traditionalImapAvailableInInboxora: true,
    connections: [{ id: 'conn-g', providerUserId: 'g-user', status: 'active' }],
  },
};

test('the connector cards expose provider setup and mailbox-account guidance', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop settings');
  await fixtureApi;
  await page.route('**/api/integrations/status', route => route.fulfill({ json: STATUS }));
  await page.goto('/');
  const panel = await openIntegrations(page);

  // A collapsed provider row is what a user sees first; expanding it exposes the
  // provider setup controls while mailbox connections remain under Accounts.
  await panel.getByText('Microsoft 365 / Outlook.com').first().click();
  await expect(panel.getByTestId('microsoft-accounts-hint')).toBeVisible();
  await expect(panel.getByText('Konfiguracja rejestracji aplikacji Azure')).toBeVisible();

  await panel.getByText('Google (Gmail, Kalendarz, Kontakty)').first().click();
  await expect(panel.getByTestId('google-accounts-hint')).toBeVisible();
  await expect(panel.getByText('Konfiguracja Google Cloud')).toBeVisible();
});
