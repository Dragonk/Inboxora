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
//
// Follow-up (4.4.2): after pinching, the zoomed view must pan with ONE finger.
// The app pins `overscroll-behavior: none` on the root scrollers (src/index.css)
// to keep browsers from hijacking row swipes; some WebView builds let that same
// lock swallow the one-finger drag instead of handing it to the zoomed visual
// viewport, so the lock is relaxed while `visualViewport.scale > 1` and reapplied
// at rest.

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

interface Cdp {
  send: (method: string, params: object) => Promise<unknown>;
}

/** Synthesizes a two-finger pinch from a `from` spread to a `to` spread. */
const pinch = async (page: Page, cdp: Cdp, center: { x: number; y: number }, from: number, to: number, step: number) => {
  const points = (spread: number) => [
    { x: Math.round(center.x - spread), y: Math.round(center.y) },
    { x: Math.round(center.x + spread), y: Math.round(center.y) },
  ];
  const direction = to >= from ? 1 : -1;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let spread = from + direction * step; direction * (to - spread) >= 0; spread += direction * step) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
};

/** Synthesizes a one-finger drag by the given deltas. */
const dragOneFinger = async (page: Page, cdp: Cdp, x: number, y: number, dx: number, dy: number) => {
  const points = (ox: number, oy: number) => [{ x: Math.round(x + ox), y: Math.round(y + oy), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0, 0) });
  for (let i = 5; i <= 60; i += 5) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points((dx * i) / 60, (dy * i) / 60) });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
};

const panState = (page: Page) => page.evaluate(() => ({
  scale: window.visualViewport.scale,
  left: window.visualViewport.offsetLeft,
  top: window.visualViewport.offsetTop,
  html: document.documentElement.style.overscrollBehavior,
  body: document.body.style.overscrollBehavior,
}));

test('pinch zoom stays effective over a fitted email body', async ({ page, fixtureApi }, testInfo) => {
  // The synthesized pinch needs a touch-enabled context; the desktop project
  // emulates a mouse-only device and does not zoom the visual viewport.
  test.skip(!testInfo.project.use.hasTouch, 'pinch zoom needs a touch-enabled mobile context');
  await openFittedEmail(page, fixtureApi);
  const before = await fitState(page);
  expect(before.marker.scale).toBeLessThan(1);
  // A synthesized pinch zooms the visual viewport in mobile emulation; the
  // shrink-to-fit state must survive the gesture untouched. The Android
  // WebView additionally reflows the layout, which the last test simulates.
  const center = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    if (!iframe) throw new Error('message frame not found');
    const rect = iframe.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 120 };
  });
  const cdp = await page.context().newCDPSession(page);
  await pinch(page, cdp, center, 10, 170, 15);
  const after = await fitState(page);
  expect(after.vpScale).toBeGreaterThan(1);
  expect(after.marker.scale).toBeCloseTo(before.marker.scale, 5);
});

test('a pinch-zoomed viewport pans with one finger and releases the root overscroll lock', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'pinch zoom needs a touch-enabled mobile context');
  await openFittedEmail(page, fixtureApi);
  // App chrome has nothing scrollable under the finger, so a one-finger drag
  // over it exercises the visual-viewport pan handoff. The mobile projects
  // have the top bar; wider (landscape/tablet) layouts fall back to the fixed
  // top strip of the window, which no scroll container claims.
  const overChrome = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="mobile-topbar"]');
    if (bar) {
      const rect = bar.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 40) };
    }
    return { x: window.innerWidth / 2, y: 24 };
  });
  const cdp = await page.context().newCDPSession(page);
  const resting = await panState(page);
  // Same tolerance as the hook's isViewportZoomed: resting scale may carry
  // float noise around 1 and still count as unzoomed.
  expect(resting.scale).toBeLessThan(1.001);
  // At rest no inline override exists: the stylesheet's
  // `overscroll-behavior: none` (pull-to-refresh / history-swipe protection)
  // is the active value.
  expect(resting.html).toBe('');
  expect(resting.body).toBe('');
  await pinch(page, cdp, overChrome, 10, 170, 15);
  const zoomed = await panState(page);
  expect(zoomed.scale).toBeGreaterThan(1);
  // While zoomed the app relaxes the root lock with an inline `auto` on both
  // root scrollers, letting one-finger drags pan the zoomed view.
  expect(zoomed.html).toBe('auto');
  expect(zoomed.body).toBe('auto');
  await dragOneFinger(page, cdp, overChrome.x, overChrome.y, -40, -70);
  const panned = await panState(page);
  // Chromium axis-locks the drag, so either axis may carry the pan; require a
  // real visual-viewport movement on one of them.
  const moved = Math.max(Math.abs(panned.left - zoomed.left), Math.abs(panned.top - zoomed.top));
  expect(moved).toBeGreaterThan(20);
  // Zooming back out removes the override so the stylesheet lock applies again.
  await pinch(page, cdp, overChrome, 170, 10, 15);
  const restored = await panState(page);
  expect(restored.scale).toBeLessThan(1.05);
  expect(restored.html).toBe('');
  expect(restored.body).toBe('');
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
