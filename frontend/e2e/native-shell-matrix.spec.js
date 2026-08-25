import { test, expect } from './fixtures.js';

const matrix = [
  ['off-off', false, false],
  ['on-off-collapsed', true, false],
  ['off-on', false, true],
  ['on-on', true, true],
];

async function openMatrix(page, fixtureApi, listEnabled, readerEnabled) {
  await fixtureApi;
  page.__conversationMatrix = `${Number(listEnabled)}${Number(readerEnabled)}`;
  await page.goto(`/?list=${Number(listEnabled)}&reader=${Number(readerEnabled)}`);
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toBeVisible();
}

test.describe('CE native shell and visual matrix', () => {
  for (const [name, listEnabled, readerEnabled] of matrix) {
    test(`${name} native geometry and screenshot`, async ({ page, fixtureApi }) => {
      await openMatrix(page, fixtureApi, listEnabled, readerEnabled);
      const listShell = page.locator('[role="list"]:visible').first();
      const nativeShell = page.locator('[data-ce-reader-enabled]:visible').first();
      await expect(nativeShell).toBeVisible();
      await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });

      const listGeometry = await nativeShell.evaluate(el => ({ left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width }));
      expect(listGeometry.width).toBeGreaterThan(0);
      const overflow = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
      expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);

      if (listEnabled) {
        const toggle = listShell.getByTestId('conversation-toggle-conversation-gmail');
        await expect(toggle).toBeVisible();
        await toggle.click();
        if (name === 'on-off-collapsed') {
          await page.screenshot({ path: 'artifacts/on-off-expanded.png', fullPage: true });
        }
        const parent = listShell.getByText('Gmail reply chain', { exact: true }).first();
        await expect(parent).toBeVisible();
        await parent.click();
        if (!readerEnabled) {
          await expect(page.getByText('Wybierz wiadomość do przeczytania', { exact: true })).not.toBeVisible();
        } else {
          await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
          const toolbar = page.locator('[data-testid="message-pane-toolbar"]:visible').first();
          await expect(toolbar).toBeVisible();
          const root = await toolbar.boundingBox();
          expect(root).not.toBeNull();
          const buttons = toolbar.locator('button:visible');
          const count = await buttons.count();
          for (let i = 0; i < count; i++) {
            const button = buttons.nth(i);
            const box = await button.boundingBox();
            expect(box, `toolbar button ${i} must have geometry`).not.toBeNull();
            expect(box.right).toBeLessThanOrEqual(root.x + root.width + 2);
            await button.click({ trial: true });
          }
        }
      }

      const readerPane = page.locator('[data-ce-reader-pane]:visible').first();
      if (readerEnabled && listEnabled) {
        await expect(readerPane).toBeVisible();
        const readerGeometry = await readerPane.evaluate(el => ({ left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width }));
        expect(readerGeometry.width).toBeGreaterThan(0);
      }
    });
  }

  test('mobile ON/ON renders native reader pane and screenshot', async ({ page, fixtureApi }) => {
    await openMatrix(page, fixtureApi, true, true);
    const list = page.locator('[role="list"]:visible').first();
    await list.getByTestId('conversation-toggle-conversation-gmail').click();
    await list.locator('[data-logical-message-id]').first().click();
    await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
    await page.screenshot({ path: 'artifacts/mobile-on-on.png', fullPage: true });
  });

  test('landscape ON/ON keeps native reader geometry and no horizontal overflow', async ({ page, fixtureApi }) => {
    await openMatrix(page, fixtureApi, true, true);
    const list = page.locator('[role="list"]:visible').first();
    await list.getByTestId('conversation-toggle-conversation-gmail').click();
    await list.locator('[data-logical-message-id]').first().click();
    await expect(page.locator('section[data-conversation-id]:visible')).toBeVisible();
    const metrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewport + 1);
    await page.screenshot({ path: 'artifacts/mobile-on-on-landscape.png', fullPage: true });
  });
});
