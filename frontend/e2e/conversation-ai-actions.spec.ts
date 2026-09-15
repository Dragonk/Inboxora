import { test, expect } from './fixtures.ts';

test('conversation AI actions visibly render their streamed result', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop conversation action contract');
  await fixtureApi;
  page.__conversationMatrix = '01';
  page.__preferencesOverride = {
    aiActions: [{ id: 'fixture-ai', label: 'Fixture AI action', prompt: 'Reply with the fixture result.' }],
  };
  await page.route('**/api/ai/chat', route => route.fulfill({
    contentType: 'text/event-stream',
    body: 'data: {"choices":[{"delta":{"content":"Visible AI fixture result"}}]}\n\ndata: [DONE]\n\n',
  }));

  await page.goto('/?list=0&reader=1');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  const reader = page.locator('section[data-conversation-id]:visible');
  const actionButton = reader.locator('button[data-message-action="ai"]').first();
  await expect(actionButton).toBeVisible();
  await actionButton.click();
  await page.getByRole('button', { name: 'Fixture AI action' }).click();

  const result = reader.getByTestId('conversation-ai-result');
  await expect(result).toContainText('Visible AI fixture result');
});
