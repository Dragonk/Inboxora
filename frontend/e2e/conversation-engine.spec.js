import { test, expect } from './fixtures.js';

async function open(page, fixtureApi, grouped, reader) {
  await fixtureApi;
  page.__conversationMatrix = `${Number(grouped)}${Number(reader)}`;
  await page.goto(`/?list=${Number(grouped)}&reader=${Number(reader)}`);
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toBeVisible();
}

test.describe('native conversation engine matrix', () => {
  test('OFF/ON resolves a flat selected physical message into its conversation (release blocker)', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toBeVisible();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-1')).toBeVisible();
    await expect(reader.locator('[data-conversation-message-state="collapsed"]')).toHaveCount(3);
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await reader.locator('#logical-message-conversation-gmail-logical-3 button[aria-expanded="false"]').click();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toContainText('Fixture body lazy');
    await reader.locator('#logical-message-conversation-gmail-logical-3 button[aria-expanded="true"]').click();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'collapsed');
    await page.screenshot({ path: 'artifacts/off-on.png', fullPage: true });
  });

  test('ON/OFF retains the native threaded list and selects its parent message', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, false);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-3"]:visible');
    await expect(parent).toBeVisible();
    await parent.click();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await page.screenshot({ path: 'artifacts/on-off-collapsed.png', fullPage: true });
  });

  test('ON/ON opens compact cards and replies against the expanded message', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    await page.locator('[data-msgid="conversation-gmail-copy-4"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toBeVisible();
    const latest = reader.locator('[data-logical-message-id="conversation-gmail-logical-4"]');
    await expect(latest.locator('[data-conversation-message-actions="true"]')).toBeVisible();
    await expect(latest.locator('[data-message-direction="outgoing"]')).toBeVisible();
    await latest.getByRole('button', { name: /Odpowiedz$|Reply$/i }).click();
    await expect(page.locator('[data-conversation-message-actions="true"]')).toHaveCount(1);
    await page.screenshot({ path: 'artifacts/on-on.png', fullPage: true });
  });
  test('ON/ON expanded native child rows expose per-message incoming/outgoing direction', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-4"]:visible');
    await parent.getByRole('button', { name: /\(4\)/ }).click();
    const directions = parent.locator('xpath=..').locator('[data-message-direction]');
    await expect(directions).toHaveCount(4);
    await expect(directions.nth(0)).toHaveAttribute('data-message-direction', 'incoming');
    await expect(directions.nth(3)).toHaveAttribute('data-message-direction', 'outgoing');
  });

});
