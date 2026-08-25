import { test, expect } from './fixtures.js';

for (const [name, grouped, reader] of [['off-off', false, false], ['on-off', true, false], ['off-on', false, true], ['on-on', true, true]]) {
  test(`${name}: native geometry screenshot`, async ({ page, fixtureApi }) => {
    await fixtureApi; page.__conversationMatrix = `${Number(grouped)}${Number(reader)}`;
    await page.goto(`/?list=${Number(grouped)}&reader=${Number(reader)}`);
    const list = page.locator('[data-ce-reader-enabled]:visible').first();
    await expect(list).toBeVisible();
    await expect(page.locator(`[data-msgid="conversation-gmail-copy-${grouped ? 4 : 3}"]:visible`)).toBeVisible();
    await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
    const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.viewport + 1);
  });
}
