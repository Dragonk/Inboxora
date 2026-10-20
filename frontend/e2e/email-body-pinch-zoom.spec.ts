import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';

// Pinch zoom in the message view.
//
// The regression this guards: shrink-to-fit recomputed its scale on every
// ResizeObserver pass. Pinch zooming the Android WebView reflows the layout -
// the CSS-pixel width of the frame shrinks while fixed-width content keeps its
// size - so the observer fired mid-gesture and the recompute scaled the body
// right back down, silently cancelling the zoom. The fit now keeps the
// recorded state while the viewport shrinks over unchanged content.

const WIDE = `<div style="width:700px;background:#ffffff;padding:16px">
<p style="font-size:23px;color:#222222;text-align:left;margin:0">Wide newsletter body, hard-coded 700px table</p>
<p style="margin:16px 0 0">A second row with more text to give the message some height for the gesture.</p>
</div>`;

const openFittedEmail = async (page: Page, fixtureApi: unknown) => {
  await fixtureApi;
  Object.assign(page, { __languageOverride: 'en', __themeOverride: 'light', __conversationMatrix: '00', __noNativeThread: true });
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: WIDE, text: '' } }));
  await page.goto('/?list=0&reader=0');
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  await expect(page.locator('iframe[sandbox]').first()).toBeVisible();
  await page.waitForTimeout(600);
};

const fitState = (page: Page) => page.evaluate(() => {
  const iframe = document.querySelector('iframe[sandbox]');
  const body = iframe?.contentDocument?.body;
  if (!body) throw new Error('message frame not found');
  const raw = body.getAttribute('data-mailflow-fit-scale');
  if (!raw) throw new Error('fit marker missing');
  return { marker: JSON.parse(raw) as { scale: number; fitViewportWidth: number }, vpScale: window.visualViewport.scale };
});

test('pinch zoom stays effective over a fitted email body', async ({ page, fixtureApi }, testInfo) => {
  // The synthesized pinch needs a touch-enabled context; the desktop project
  // emulates a mouse-only device and does not zoom the visual viewport.
  test.skip(!testInfo.project.use.hasTouch, 'pinch zoom needs a touch-enabled mobile context');
  await openFittedEmail(page, fixtureApi);
  const before = await fitState(page);
  expect(before.marker.scale).toBeLessThan(1);
  // A synthesized pinch zooms the visual viewport in mobile emulation; the
  // shrink-to-fit state must survive the gesture untouched. The Android
  // WebView additionally reflows the layout, which the next test simulates.
  const center = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    if (!iframe) throw new Error('message frame not found');
    const rect = iframe.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 120 };
  });
  const cdp = await page.context().newCDPSession(page);
  const points = (spread: number) => [
    { x: Math.round(center.x - spread), y: Math.round(center.y) },
    { x: Math.round(center.x + spread), y: Math.round(center.y) },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(10) });
  for (let spread = 20; spread <= 170; spread += 15) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
  const after = await fitState(page);
  expect(after.vpScale).toBeGreaterThan(1);
  expect(after.marker.scale).toBeCloseTo(before.marker.scale, 5);
});

test('a layout-viewport shrink keeps the fitted scale instead of cancelling the zoom', async ({ page, fixtureApi }, testInfo) => {
  // A touch-gesture regression: the desktop reader pane has its own geometry
  // (collapsing sidebars can even widen it while the page narrows), so the
  // WebView reflow is exercised on the phone-shaped projects only.
  test.skip(testInfo.project.name === 'chromium-desktop', 'desktop reader pane geometry is not tied to the page viewport');
  await openFittedEmail(page, fixtureApi);
  const before = await fitState(page);
  expect(before.marker.scale).toBeLessThan(1);
  const size = page.viewportSize();
  if (!size) throw new Error('viewport size unavailable');
  // Shrink the layout viewport by 15 percent WITHOUT crossing the app's
  // wide/narrow layout breakpoint: crossing it switches the reader layout and
  // legitimately starts a fresh fit. The shrink itself mirrors a pinch zoom
  // step on the Android WebView, which narrows the CSS-pixel layout width
  // while fixed-width content keeps its size.
  const shrunkWidth = size.width > 768 ? Math.max(780, Math.floor(size.width * 0.85)) : Math.floor(size.width * 0.85);
  await page.setViewportSize({ width: shrunkWidth, height: size.height });
  await page.waitForTimeout(700);
  const shrunk = await fitState(page);
  expect(shrunk.marker.scale).toBeCloseTo(before.marker.scale, 5);
  expect(shrunk.marker.fitViewportWidth).toBeLessThan(before.marker.fitViewportWidth);
  // Growing the layout viewport again (zoom out, rotation, a panel closing)
  // re-derives the fit toward the natural size.
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(700);
  const grown = await fitState(page);
  expect(grown.marker.fitViewportWidth).toBeGreaterThan(shrunk.marker.fitViewportWidth);
  expect(grown.marker.scale).toBeGreaterThanOrEqual(shrunk.marker.scale);
});
