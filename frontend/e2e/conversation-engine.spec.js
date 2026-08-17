import { test, expect } from './fixtures.js';

function visibleList(page) {
  return page.locator('[role="list"]:visible').first();
}

test.describe('conversation engine browser E2E', () => {
  test.beforeEach(async ({ page, fixtureApi }) => {
    await fixtureApi;
    await page.goto('/');
    await expect(visibleList(page)).toBeVisible();
  });

  test('renders Gmail-like cards, latest-own marker, expands children and opens target', async ({ page }) => {
    const list = visibleList(page);
    await expect(list.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(list.getByLabel(/Najnowsza własna odpowiedź|Latest own reply/i).first()).toBeVisible();
    const expand = list.locator('[data-testid="conversation-expand-conversation-gmail"]');
    await expand.click();
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    await list.getByRole('button', { name: 'Gmail reply chain', exact: true }).last().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await expect(pane).toBeVisible();
    await pane.locator('article').first().locator('button').first().click({ force: true });
    await expect(pane.locator('[role="region"]:visible').first()).toBeVisible();
    await expect(pane.getByText('Fixture body 1', { exact: true })).toBeVisible();
  });

  test('supports reply and manual split controls', async ({ page }) => {
    const list = visibleList(page);
    await list.getByText('Gmail reply chain', { exact: true }).first().click();
    const pane = page.locator('section[data-conversation-id]:visible').first();
    await pane.locator('article').first().locator('button').first().click({ force: true });
    await expect(pane.getByRole('button', { name: /Odpowiedz|Reply/i }).first()).toBeVisible();
    await expect(pane.getByRole('button', { name: /Podziel|Split/i }).first()).toBeVisible();
  });

  test('keeps the feature matrix and Polish UI usable on mobile', async ({ page, isMobile }) => {
    if (!isMobile) test.skip();
    await expect(visibleList(page).getByText('Gmail reply chain', { exact: true })).toBeVisible();
    await expect(visibleList(page)).toHaveAttribute('aria-label', /Rozmowy|Conversations/i);
  });
});
