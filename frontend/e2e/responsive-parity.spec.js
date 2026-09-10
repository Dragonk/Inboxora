import { test, expect } from './fixtures.js';

const MOBILE_PROJECTS = new Set(['chromium-mobile-390', 'chromium-mobile']);

function isMobileProject(testInfo) {
  return MOBILE_PROJECTS.has(testInfo.project.name);
}

async function expectSingleVisibleContentPanel(page, mobile) {
  const panelCounts = await page.evaluate((mobileView) => {
    const selectors = mobileView
      ? ['[data-ce-reader-enabled]:visible', '[data-testid="contacts-mobile-list"]:visible', '[data-testid="calendar-page"]:visible']
      : ['[data-ce-reader-enabled]:visible', '[data-testid="contacts-desktop-list"]:visible', '[data-testid="calendar-page"]:visible'];
    return selectors.map(selector => document.querySelectorAll(selector.replace(':visible', '')).length === 0 ? 0 : Array.from(document.querySelectorAll(selector.replace(':visible', ''))).filter(element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }).length);
  }, mobile);
  expect(panelCounts.reduce((total, count) => total + count, 0)).toBe(1);
}

async function captureState(page, testInfo, state) {
  await page.screenshot({
    path: testInfo.outputPath(`responsive-${testInfo.project.name}-${state}.png`),
    fullPage: true,
  });
}

async function expectDesktopGeometry(page, state) {
  const viewport = page.viewportSize();
  const contacts = page.getByTestId('contacts-desktop-list');
  const detail = page.getByTestId('contacts-desktop-detail');
  const calendar = page.getByTestId('calendar-page');
  const panels = state === 'contacts' ? [contacts, detail] : [calendar];

  for (const panel of panels) {
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  if (state === 'contacts') {
    const [contactsBox, detailBox] = await Promise.all([contacts.boundingBox(), detail.boundingBox()]);
    expect(detailBox.x).toBeGreaterThanOrEqual(contactsBox.x + contactsBox.width - 1);
    expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }
}

async function expectMobileControlsUsable(page, control) {
  const viewport = page.viewportSize();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await expect(page.getByTestId('mobile-topbar-menu')).toBeVisible();
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

async function exerciseParityFlow({ page, testInfo, fixtureApi }) {
  await fixtureApi;
  const mobile = isMobileProject(testInfo);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-ce-reader-enabled]').first()).toBeVisible();

  if (mobile) await expect(page.getByTestId('mobile-topbar-menu')).toBeVisible();

  await expectSingleVisibleContentPanel(page, mobile);
  await captureState(page, testInfo, 'mail');

  if (mobile) {
    await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('contacts-nav-mobile').click();
    await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
    await expectMobileControlsUsable(page, page.getByTestId('contacts-mobile-fab'));
  } else {
    await page.getByTestId('contacts-nav-primary').click();
    await expect(page.getByTestId('contacts-desktop-list')).toBeVisible();
    await expect(page.getByTestId('contacts-desktop-detail')).toBeVisible();
    await expectDesktopGeometry(page, 'contacts');
  }
  await expectSingleVisibleContentPanel(page, mobile);
  await captureState(page, testInfo, 'contacts');

  if (mobile) {
    await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('calendar-nav-mobile').click();
  } else {
    await page.getByTestId('calendar-nav-primary').click();
  }
  await expect(page.getByTestId('calendar-page')).toBeVisible();
  if (!mobile) await expectDesktopGeometry(page, 'calendar');
  if (mobile) {
    await expectMobileControlsUsable(page, page.getByTestId('calendar-mobile-new-event'));
  }
  await expectSingleVisibleContentPanel(page, mobile);
  await captureState(page, testInfo, 'calendar');

  if (mobile) {
    await page.getByTestId('calendar-mobile-back').click();
  } else {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-ce-reader-enabled]').first()).toBeVisible();
  }
  await expectSingleVisibleContentPanel(page, mobile);
}

test('responsive Mail Contacts Calendar parity flow', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile-landscape', 'Acceptance matrix covers portrait mobile widths only');
  await exerciseParityFlow({ page, testInfo, fixtureApi });
});
