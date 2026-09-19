import { test, expect } from './fixtures.ts';

// The connector card had no browser coverage: no spec referenced the integrations status, the
// card or its sub-tabs, so a green suite said nothing about the interface this work changed.
// This drives it from the payload it renders and the two things a user can do there.
async function openIntegrations(page) {
  await page.getByTestId('sidebar-user-menu').click();
  await page.getByText('Ustawienia', { exact: true }).first().click();
  const panel = page.locator('.admin-panel');
  await panel.locator('.admin-tab').filter({ hasText: /^Integracje$/ }).click();
  await panel.getByRole('button', { name: 'Dostawcy poczty e-mail' }).click();
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

test('the connector card states the Microsoft requirement, lists accounts, and disconnects one', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop settings');
  await fixtureApi;
  const disconnects: string[] = [];
  await page.route('**/api/integrations/status', route => route.fulfill({ json: STATUS }));
  await page.route('**/api/integrations/provider-connections/*/disconnect', route => {
    disconnects.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { connectionId: 'conn-g', collectionsDisabled: 1 } });
  });
  await page.goto('/');
  const panel = await openIntegrations(page);

  // A collapsed provider row is what a user sees first; expanding it is where the requirement,
  // the connected accounts and the disconnect control live.
  await panel.getByText('Microsoft 365 / Outlook.com').first().click();
  await expect(panel.getByTestId('microsoft-mail-policy')).toContainText('wymaga');
  await expect(panel.getByTestId('microsoft-connected-account')).toHaveText('ms-user');

  await panel.getByText('Google (Gmail, Kalendarz, Kontakty)').first().click();
  // The Google recommendation is stated by the provider description that predates this work, so
  // the card must not contradict it.
  await expect(panel.getByText('Zalecane połączenie przez API')).toBeVisible();
  await expect(panel.getByTestId('google-connected-account')).toHaveText('g-user');

  // Disconnecting asks for a specific account rather than a provider-wide guess.
  await panel.getByTestId('google-disconnect-account').click();
  await expect.poll(() => disconnects.length).toBe(1);
  expect(disconnects[0]).toContain('/provider-connections/conn-g/disconnect');
});
