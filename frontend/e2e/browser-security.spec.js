import { test, expect } from './fixtures.js';
test('conversation body keeps renderer security boundary', async ({ page, fixtureApi }) => {
  await fixtureApi; page.__conversationMatrix = '01'; await page.goto('/?list=0&reader=1');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  const reader = page.locator('section[data-conversation-id]:visible');
  await expect(reader).toBeVisible();
  await expect(reader.locator('script')).toHaveCount(0);
});
