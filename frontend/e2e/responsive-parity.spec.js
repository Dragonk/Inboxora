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
  const navigation = page.getByTestId('mobile-primary-nav');
  const [controlBox, navigationBox] = await Promise.all([control.boundingBox(), navigation.boundingBox()]);
  expect(controlBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(controlBox.x).toBeGreaterThanOrEqual(0);
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(viewport.width);
  expect(controlBox.y).toBeGreaterThanOrEqual(0);
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(navigationBox.y - 16);

  const hitTest = await page.evaluate(({ controlCenter, navigationCenters }) => ({
    control: document.elementFromPoint(controlCenter.x, controlCenter.y)?.closest('button') != null,
    navigation: navigationCenters.map(({ x, y }) => document.elementFromPoint(x, y)?.closest('button') != null),
  }), {
    controlCenter: { x: controlBox.x + controlBox.width / 2, y: controlBox.y + controlBox.height / 2 },
    navigationCenters: await Promise.all(['Wszystkie skrzynki odbiorcze', 'Kontakty', 'Kalendarz'].map(async name => {
      const box = await navigation.getByRole('button', { name }).boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })),
  });
  expect(hitTest.control).toBe(true);
  expect(hitTest.navigation).toEqual([true, true, true]);
}

async function exerciseParityFlow({ page, testInfo, fixtureApi }) {
  await fixtureApi;
  const mobile = isMobileProject(testInfo);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-ce-reader-enabled]').first()).toBeVisible();

  const mobileNavigation = page.getByTestId('mobile-primary-nav');
  if (mobile) await expect(mobileNavigation).toBeVisible();

  await expectSingleVisibleContentPanel(page, mobile);
  await captureState(page, testInfo, 'mail');

  if (mobile) {
    await mobileNavigation.getByRole('button', { name: 'Kontakty' }).click();
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
    await mobileNavigation.getByRole('button', { name: 'Kalendarz' }).click();
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
    await mobileNavigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' }).click();
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
