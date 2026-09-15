import { test, expect } from './fixtures.ts';
test('conversation body keeps renderer security boundary', async ({ page, fixtureApi }) => {
  await fixtureApi; page.__conversationMatrix = '01'; await page.goto('/?list=0&reader=1');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  const reader = page.locator('section[data-conversation-id]:visible');
  await expect(reader).toBeVisible();
  await expect(reader.locator('script')).toHaveCount(0);
});

test('mail-body links open through Inboxora and right-click keeps its action menu', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop pointer menu contract');
  await fixtureApi; page.__conversationMatrix = '01'; await page.goto('/?list=0&reader=1');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  const reader = page.locator('section[data-conversation-id]:visible');
  const iframe = reader.locator('iframe').first();
  const frame = iframe.contentFrame();
  await expect(frame.getByRole('link', { name: 'Safe link' })).toBeVisible();

  await page.evaluate(() => {
    const target = window as Window & { openedMailLinks?: string[] };
    target.openedMailLinks = [];
    window.open = ((url?: string | URL) => {
      target.openedMailLinks?.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await frame.getByRole('link', { name: 'Safe link' }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { openedMailLinks?: string[] }).openedMailLinks)).toEqual(['https://example.test/']);

  await frame.getByRole('link', { name: 'Safe link' }).dispatchEvent('contextmenu', { button: 2, clientX: 24, clientY: 24 });
  await expect(page.getByTestId('message-context-menu')).toBeVisible();
});

test('mail-body text keeps native touch selection and copy affordances', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium-mobile'), 'touch selection contract');
  await fixtureApi; page.__conversationMatrix = '01'; await page.goto('/?list=0&reader=1');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  const reader = page.locator('section[data-conversation-id]:visible');
  const frame = reader.locator('iframe').first().contentFrame();
  const body = frame.locator('body');
  await expect(body).toContainText('Fixture body lazy');
  await expect.poll(() => body.evaluate(element => getComputedStyle(element).userSelect)).toBe('text');

  // On a coarse pointer the browser keeps its long-press selection/copy UI instead
  // of replacing it with the desktop Inboxora context menu.
  await body.dispatchEvent('contextmenu', { clientX: 24, clientY: 24 });
  await expect(page.getByTestId('message-context-menu')).toHaveCount(0);
});
