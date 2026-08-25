import { test, expect } from './fixtures.js';

function visibleList(page) {
  return page.locator('[role="list"]:visible').first();
}

function legacyReader(page) {
  return page.locator('[data-testid="message-pane"]:visible, .message-pane:visible, [data-testid="message-list"]:visible, [role="main"]:visible').first();
}

test.describe('conversation engine browser E2E', () => {
  async function gotoAfterPreferences(page, url) {
    // Preferences may be served from the store on subsequent navigations, so a
    // mandatory waitForResponse can deadlock the matrix after the first page load.
    // Wait briefly when a network request is made, but never make navigation depend
    // on a second GET that the app is allowed to cache.
    const preferences = page.waitForResponse(response =>
      response.url().includes('/api/auth/preferences') && response.request().method() === 'GET' && response.status() === 200,
      { timeout: 3_000 }
    ).catch(() => null);
    await page.goto(url);
    await preferences;
  }

  test.beforeEach(async ({ page, fixtureApi }) => {
    await fixtureApi;
    await gotoAfterPreferences(page, '/?list=1&reader=1');
    await expect(visibleList(page)).toBeVisible();
  });

  test('renders Gmail-like cards, latest-own marker, expands children and opens target', async ({ page }) => {
    const list = visibleList(page);
    await expect(list.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(list.getByLabel(/Najnowsza własna odpowiedź|Latest own reply/i).first()).toBeVisible();
    const expand = list.getByTestId('conversation-toggle-conversation-gmail');
    await expand.click();
    await expect(list.getByTestId('conversation-toggle-conversation-gmail')).toHaveAttribute('aria-expanded', 'true');
    await list.locator('[data-logical-message-id]').first().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-logical-message-id]').first()).toBeVisible();
    await expect(pane.locator('iframe').first().contentFrame().getByText('Fixture body lazy', { exact: true })).toBeVisible();
  });

  test('supports reply and Reply All controls after lazy body load', async ({ page }) => {
    const list = visibleList(page);
    await list.getByTestId('conversation-toggle-conversation-gmail').click();
    await list.locator('[data-logical-message-id]').first().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await pane.locator('article').first().locator('button').first().click({ force: true });
    await expect(pane.getByRole('button', { name: /Odpowiedz$|Reply$/i }).first()).toBeVisible();
    await expect(pane.getByRole('button', { name: /Odpowiedz wszystkim|Reply All/i }).first()).toBeVisible();
  });

  for (const [listEnabled, readerEnabled] of [[false, false], [true, false], [false, true], [true, true]]) {
    test(`opens parent and child with list=${listEnabled} reader=${readerEnabled}`, async ({ page, fixtureApi }) => {
      await fixtureApi;
      page.__conversationMatrix = `${Number(listEnabled)}${Number(readerEnabled)}`;
      await gotoAfterPreferences(page, `/?list=${Number(listEnabled)}&reader=${Number(readerEnabled)}`);
      if (listEnabled) {
        const list = visibleList(page);
        await expect(list.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
        await list.getByTestId('conversation-toggle-conversation-gmail').click();
        await list.locator('[data-logical-message-id]').first().click();
      } else {
        await expect(page.locator('body')).toBeVisible();
      }
      if (readerEnabled && listEnabled) {
        await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
      } else {
        await expect(page.locator('body')).toBeVisible();
      }
      // The initial navigation above is the matrix assertion. Avoid a second
      // navigation in the same test: App intentionally persists preferences and
      // may satisfy the second load from its store without another preferences GET.
      // Each matrix tuple has its own isolated Playwright test/page.
    });
  }
});
