import { test, expect } from './fixtures.js';

test('returning from Calendar preserves the unified list and expanded thread without waiting for the network', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and touch latency contracts');
  page.__conversationMatrix = '10';
  await page.route('**/api/accounts', route => route.fulfill({ json: fixtureApi.accounts.map(account => ({ ...account, enabled: true })) }));
  let requests = 0;
  await page.route(url => url.pathname === '/api/mail/messages', async route => {
    requests += 1;
    await new Promise(resolve => setTimeout(resolve, 600));
    return route.fallback();
  });
  await page.goto('/?list=1&reader=0');
  const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
  await expect(parent).toBeVisible();
  await parent.locator("button[aria-label*='(5)']").click();
  const child = page.locator('[data-thread-row-child="conversation-gmail-copy-2"]:visible');
  await expect(child).toBeVisible();
  const mobile = page.viewportSize().width < 768;
  const measurements = [];
  for (let index = 0; index < 5; index += 1) {
    if (mobile) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId(mobile ? 'calendar-nav-mobile' : 'calendar-nav-primary').click();
    await expect(page.getByTestId('calendar-page')).toBeVisible();
    if (mobile) await page.getByTestId('mobile-topbar-menu').click();
    const before = requests;
    await page.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze', exact: true }).evaluate(element => {
      window.__navigationStart = performance.now();
      element.click();
    });
    await expect(parent).toBeVisible();
    const elapsed = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__navigationStart)))));
    measurements.push({ clickToPaintMs: Math.round(elapsed), listRequests: requests - before });
    if (!process.env.PERF_BASELINE) {
      await expect(child).toBeVisible();
      expect(requests - before).toBe(0);
      expect(elapsed).toBeLessThan(300);
    } else if (!(await child.isVisible())) {
      await parent.locator("button[aria-label*='(5)']").click();
      await expect(child).toBeVisible();
    }
  }
  console.info('unified-navigation', testInfo.project.name, JSON.stringify(measurements));
  await testInfo.attach('navigation-latency.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});
