import { test, expect } from './fixtures.ts';

async function installOverlay(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      height: 48,
      getTitlebarAreaRect() { return { height: overlay.height }; },
    });
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  });
}

async function changeOverlayHeight(page: import('@playwright/test').Page, height: number) {
  await page.evaluate((nextHeight) => {
    const overlay = (navigator as Navigator & {
      windowControlsOverlay: EventTarget & { height: number };
    }).windowControlsOverlay;
    overlay.height = nextHeight;
    overlay.dispatchEvent(new Event('geometrychange'));
  }, height);
}

test('drag strip follows overlay height while it stays visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop overlay geometry');
  await installOverlay(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.goto('/login');

  const strip = page.getByTestId('desktop-titlebar-drag');
  await expect(strip).toHaveCSS('height', '48px');
  await changeOverlayHeight(page, 72);
  await expect(strip).toHaveCSS('height', '72px');
});

test('scaled mail viewport follows overlay height without window resize', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop overlay geometry');
  await fixtureApi;
  page.__preferencesOverride = { fontSize: '125' };
  await installOverlay(page);
  await page.goto('/');

  const content = page.locator('[style*="--app-height:"]');
  const viewportHeight = page.viewportSize()!.height;
  const expectScaledHeight = (overlayHeight: number) => expect.poll(() => content.evaluate(element =>
    Number((element as HTMLElement).style.height.replace('px', '')),
  )).toBeCloseTo((viewportHeight - overlayHeight) / 1.25, 1);
  await expectScaledHeight(48);
  await changeOverlayHeight(page, 72);
  await expectScaledHeight(72);
});
