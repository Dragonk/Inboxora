import { test, expect } from './fixtures.js';

function visibleList(page) {
  return page.locator('[role="list"]:visible').first();
}

function legacyReader(page) {
  return page.locator('[data-testid="message-pane"]:visible, .message-pane:visible, [data-testid="message-list"]:visible, [role="main"]:visible').first();
}

test.describe('conversation engine browser E2E', () => {
  test.beforeEach(async ({ page, fixtureApi }) => {
    await fixtureApi;
    await page.goto('/?list=1&reader=1');
    await expect(visibleList(page)).toBeVisible();
  });

  test('renders Gmail-like cards, latest-own marker, expands children and opens target', async ({ page }) => {
    const list = visibleList(page);
    await expect(list.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(list.getByLabel(/Najnowsza własna odpowiedź|Latest own reply/i).first()).toBeVisible();
    const expand = list.locator('[data-testid="conversation-expand-conversation-gmail"]');
    await expand.click();
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    await list.locator('[data-logical-message-id]').first().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-logical-message-id]').first()).toBeVisible();
    await expect(pane.getByText('Fixture body lazy', { exact: true }).first()).toBeVisible();
  });

  test('supports reply and Reply All controls after lazy body load', async ({ page }) => {
    const list = visibleList(page);
    await list.getByText('Gmail reply chain', { exact: true }).first().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await pane.locator('article').first().locator('button').first().click({ force: true });
    await expect(pane.getByRole('button', { name: /Odpowiedz$|Reply$/i }).first()).toBeVisible();
    await expect(pane.getByRole('button', { name: /Odpowiedz wszystkim|Reply All/i }).first()).toBeVisible();
  });

  for (const [listEnabled, readerEnabled] of [[false, false], [true, false], [false, true], [true, true]]) {
    test(`opens parent and child with list=${listEnabled} reader=${readerEnabled}`, async ({ page, fixtureApi }) => {
      await fixtureApi;
      page.__conversationMatrix = `${Number(listEnabled)}${Number(readerEnabled)}`;
      await page.goto(`/?list=${Number(listEnabled)}&reader=${Number(readerEnabled)}`);
      if (listEnabled) {
        const list = visibleList(page);
        await expect(list.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
        await list.getByText('Gmail reply chain', { exact: true }).first().click();
      } else {
        await expect(page.locator('body')).toBeVisible();
      }
      if (readerEnabled && listEnabled) {
        await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
      } else {
        await expect(page.locator('body')).toBeVisible();
      }
      if (listEnabled) {
        await page.goto(`/?list=${Number(listEnabled)}&reader=${Number(readerEnabled)}`);
        const expandedList = visibleList(page);
        await expandedList.locator('[data-testid="conversation-expand-conversation-gmail"]').click();
        await expandedList.locator('[data-logical-message-id]').first().click();
        if (readerEnabled && listEnabled) await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
        else await expect(page.locator('body')).toBeVisible();
      }
    });
  }
});
