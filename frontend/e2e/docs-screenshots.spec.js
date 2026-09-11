import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { navigateModule } from './v3-fixtures.js';
import { selectCalendarView } from './navigation.js';
import {
  DOCS_CLOCK,
  DOCS_THEME,
  assertDocsPresentation,
  demoConversationId,
  demoCopyId,
  demoLogicalId,
  newestDemoRowId,
  useDavDemoData,
  useEnglishLocale,
  useEnglishMailData,
  useEnglishWorkspaceData,
} from './docs-demo.js';

// Documentation screenshot generator.
//
// These captures feed the README and the GitHub Wiki (`media/screenshots/`). They run
// against the real application with one shared, populated English demo dataset
// (`docs-demo.js`), so every image shows the same product in the same style, with real
// content instead of empty states.
//
// The regular browser gate never runs this file. `.github/workflows/docs-screenshots.yml`
// regenerates and verifies the set on demand and on every change to the inputs. Locally:
//
//   cd frontend
//   DOCS_SCREENSHOTS=1 npx playwright test e2e/docs-screenshots.spec.js \
//     --project=chromium-desktop --project=chromium-mobile-390
//
// Each scenario is captured for both layouts — `-desktop` at 1440×900 and `-mobile` at
// 390×844. Only viewport-sized images are taken, so `fullPage` is never used and the
// captures always show what a user actually sees.

const OUTPUT_DIR = fileURLToPath(new URL('../../media/screenshots/', import.meta.url));
const enabled = Boolean(process.env.DOCS_SCREENSHOTS);

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (enabled) mkdirSync(OUTPUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!enabled, 'documentation screenshots are generated on demand with DOCS_SCREENSHOTS=1');
  const desktop = testInfo.project.name === 'chromium-desktop';
  const phone = testInfo.project.name === 'chromium-mobile-390';
  test.skip(!desktop && !phone, 'desktop and 390px phone references only');
  page.__isDesktop = desktop;
  page.__languageOverride = 'en';
  page.__themeOverride = DOCS_THEME;
  await useEnglishLocale(page);
  // Freeze the clock for every capture, not only the calendar ones: the message list
  // prints times, the week grid draws a "now" line, and relative dates would otherwise
  // make two runs of the same code produce different pixels (and flap the CI staleness
  // check).
  await page.clock.setFixedTime(new Date(DOCS_CLOCK));
  if (desktop) await page.setViewportSize({ width: 1440, height: 900 });
});

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(
    animation => animation.effect?.getComputedTiming().endTime === Infinity || animation.playState !== 'running',
  ));
}

/**
 * Waits until a scroll container stops moving, optionally pinning it first.
 *
 * The conversation reader scrolls itself to align the selected message, and it does that
 * again when a lazily loaded body changes the pane height. Left alone, the capture races
 * that alignment and the same code produces different pixels between runs. So: let the
 * reader finish, pin the pane, then confirm nothing re-snapped.
 */
async function settleScroll(locator, page, { pin = null } = {}) {
  await waitForStableScroll(locator, page);
  if (pin !== null) await locator.evaluate((element, value) => { element.scrollTop = value; }, pin);
  return waitForStableScroll(locator, page);
}

/** Resolves once scrollTop and scrollHeight have both been unchanged for three reads. */
async function waitForStableScroll(locator, page) {
  let previous = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await locator.evaluate(element => `${element.scrollTop}:${element.scrollHeight}`);
    stableReads = current === previous ? stableReads + 1 : 0;
    previous = current;
    if (stableReads >= 3) return current;
    await page.waitForTimeout(120);
  }
  throw new Error(`The reading pane never settled (last state: ${previous}).`);
}

/**
 * Captures the viewport after asserting the presentation contract, so an empty list, an
 * unthemed page, a missing unified-inbox entry point or a blank reading pane fails the
 * run instead of shipping a screenshot that undersells the application.
 */
async function capture(page, name, { mode = 'mail-list', require: required = [], variant = page.__isDesktop ? 'desktop' : 'mobile' } = {}) {
  await parkPointer(page);
  await settle(page);
  await assertDocsPresentation(page, { mode, require: required });
  await page.screenshot({ path: `${OUTPUT_DIR}${name}-${variant}.png`, animations: 'disabled' });
}

/**
 * Moves the pointer out of the way before a capture.
 *
 * Playwright leaves the cursor where it clicked, and whether that element keeps its hover
 * style once a modal covers it depends on when the browser re-runs hit testing. The
 * Compose button's hover opacity, seen through the composer's blurred backdrop, made the
 * same run differ by 0.7 % of pixels from one launch to the next. Parking the pointer
 * removes pointer state as a variable for every capture, not just the composer.
 */
async function parkPointer(page) {
  await page.mouse.move(2, 2);
  // Hover styles here are transitions, so give them a chance to finish before the
  // animation wait in settle() decides the page is idle.
  await page.waitForTimeout(200);
}

/** Opens the mail module with the shared demo data registered. */
async function openMail(page, fixtureApi) {
  await fixtureApi;
  await useEnglishMailData(page);
  page.__conversationMatrix = '11';
  const listLoaded = page.waitForResponse(response => response.request().method() === 'GET' && response.ok() && new URL(response.url()).pathname === '/api/mail/messages');
  await page.goto('/?list=1&reader=1', { waitUntil: 'domcontentloaded' });
  await listLoaded;
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled', 'true');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await expect(page.getByTestId('all-inboxes')).toBeVisible();
}

const threadRow = page => page.locator(`[data-msgid="${newestDemoRowId()}"]:visible`);

async function expandDemoThread(page) {
  await threadRow(page).locator("button[aria-label*='(4)']").click();
  await expect(threadRow(page).locator('[data-thread-row-child]')).toHaveCount(4);
}

/** Expands the demo conversation and opens one of its messages in the reading pane. */
async function openDemoConversation(page, copy = demoCopyId(3)) {
  await expandDemoThread(page);
  await threadRow(page).locator(`[data-thread-row-child="${copy}"]`).click();
  const reader = page.locator(`section[data-conversation-id="${demoConversationId()}"]:visible`);
  await expect(reader).toBeVisible();
  await expect(reader.locator('iframe').first()).toBeVisible();
  await settleScroll(reader, page, { pin: 0 });
  return reader;
}

function composeButton(page) {
  return (page.__isDesktop ? page.locator('.inboxora-sidebar') : page.getByTestId('mobile-topbar')).getByRole('button', { name: 'Compose', exact: true });
}

// Every scenario registers the same mail demo data, so the sidebar (accounts, folders,
// unified inbox) looks identical in the mail, calendar, contacts and settings captures
// instead of changing shape between them.
async function openCalendar(page, fixtureApi) {
  await fixtureApi;
  await useEnglishMailData(page);
  await useEnglishWorkspaceData(page);
  await page.goto('/');
  await navigateModule(page, 'calendar');
}

async function openContacts(page, fixtureApi) {
  await fixtureApi;
  await useEnglishMailData(page);
  await useEnglishWorkspaceData(page);
  await page.goto('/');
  await navigateModule(page, 'contacts');
  await page.getByRole('button', { name: 'Priya Raman', exact: true }).click();
}

async function openSettings(page) {
  if (!page.__isDesktop) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.__isDesktop) await page.getByText('Settings', { exact: true }).first().click();
  else await page.getByTestId('mobile-settings').click();
  await expect(page.locator('.admin-panel')).toBeVisible();
}

async function openSettingsTab(page, name) {
  const button = page.locator('.admin-panel').getByRole('button', { name, exact: true }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

// Appearance groups its options into sub-tabs; the threading settings and the
// conversation rebuild live under Layout, not on the default Theme sub-tab.
async function openSettingsSubTab(page, name) {
  const button = page.locator('.admin-panel').getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

// The hero image: a mailbox that is actually in use. The conversation is expanded in the
// list and one of its messages is open in the reading pane, so the image shows threading
// and reading at the same time rather than an empty shell.
test('mail: unified inbox with an expanded thread and an open message', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  await openDemoConversation(page, demoCopyId(3));
  await capture(page, 'mail-inbox', { mode: 'mail-reader' });
});

// The conversation reader with the thread history expanded, which is what reading a long
// conversation actually looks like.
test('mail: conversation reader with the thread history expanded', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  const reader = await openDemoConversation(page, demoCopyId(4));
  for (const index of [1, 2]) {
    const toggle = reader.locator(`#logical-message-${demoLogicalId(index)} [data-conversation-message-toggle="true"][aria-expanded="false"]`);
    if (await toggle.count()) await toggle.click();
  }
  await expect.poll(() => reader.locator('iframe').count()).toBeGreaterThanOrEqual(3);
  // Expanding more messages changes the pane height, so re-pin the scroll position.
  await settleScroll(reader, page, { pin: 0 });
  await capture(page, 'mail-conversation', { mode: 'mail-reader' });
});

test('mail: composer with a real message being written', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  await composeButton(page).click();
  await expect(page.getByRole('button', { name: /Send/ }).first()).toBeVisible();
  await page.getByPlaceholder('recipient@example.com').first().fill('priya@northwind.studio');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).first().fill('Q4 launch checklist — Thursday review');
  const body = [
    'Hi Priya,',
    '',
    'Thanks for the pricing feedback. I kept the annual toggle visible and froze the branch, so Thursday works.',
    '',
    '1. Landing page copy — final',
    '2. Pricing table — updated in the attachment',
    '3. Onboarding emails — approved',
    '',
    'Best,',
    'Anna',
  ].join('\n');
  const richBody = page.locator('.tiptap-compose [contenteditable="true"]').first();
  if (await richBody.count()) await richBody.fill(body);
  else await page.getByPlaceholder('Write your message…').first().fill(body);
  await expect(page.getByPlaceholder(/^(Add a subject|Subject)$/).first()).toHaveValue('Q4 launch checklist — Thursday review');
  await capture(page, 'mail-composer');
});

test('calendar: month, week and agenda views', async ({ page, fixtureApi }) => {
  await openCalendar(page, fixtureApi);
  await expect(page.getByTestId('calendar-month-grid')).toBeVisible();
  await capture(page, 'calendar-month', { mode: 'workspace', require: [
    page.getByTestId('calendar-month-grid'),
    page.getByText('Design review', { exact: false }).first(),
  ] });
  if (!page.__isDesktop) await page.getByTestId('calendar-month-grid').getByRole('button', { name: /more/ }).first().click();
  await selectCalendarView(page, 'week');
  await expect(page.getByTestId('calendar-time-grid-scroll')).toBeVisible();
  await capture(page, 'calendar-week', { mode: 'workspace', require: [
    page.getByTestId('calendar-time-grid-scroll'),
    page.getByText('Sprint planning', { exact: false }).first(),
  ] });
  await selectCalendarView(page, 'agenda');
  await expect(page.getByTestId('calendar-agenda-view')).toBeVisible();
  await capture(page, 'calendar-agenda', { mode: 'workspace', require: [
    page.getByTestId('calendar-agenda-view'),
    page.getByText('Roadmap wrap-up', { exact: false }).first(),
  ] });
});

test('contacts: details and the rich editor', async ({ page, fixtureApi }) => {
  await openContacts(page, fixtureApi);
  await expect(page.getByText('Northwind Studio', { exact: false }).first()).toBeVisible();
  await capture(page, 'contacts', { mode: 'workspace', require: [
    page.getByText('Priya Raman', { exact: false }).first(),
    page.getByText('Product designer', { exact: false }).first(),
  ] });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Nickname', { exact: true })).toBeVisible();
  await capture(page, 'contact-editor', { mode: 'workspace', require: [
    page.getByLabel('Nickname', { exact: true }),
    page.getByLabel('Job title', { exact: true }),
  ] });
});

test('settings: appearance, DAV access and about', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  await useDavDemoData(page);
  await openSettings(page);
  await openSettingsTab(page, 'Appearance');
  await capture(page, 'settings-appearance', { mode: 'workspace', require: [
    page.getByText('Appearance', { exact: true }).first(),
  ] });
  await openSettingsTab(page, 'DAV access');
  await expect(page.getByText('Pixel 7 · DAVx5', { exact: true })).toBeVisible();
  await capture(page, 'settings-dav-access', { mode: 'workspace', require: [
    page.getByText('Pixel 7 · DAVx5', { exact: true }),
    page.getByText('Thunderbird · laptop', { exact: true }),
  ] });
  await openSettingsTab(page, 'About');
  await expect(page.getByText('4.0.0', { exact: true })).toBeVisible();
  await capture(page, 'settings-about', { mode: 'workspace', require: [
    page.getByText('AGPL-3.0', { exact: true }),
  ] });
});

// The rebuild is the step that groups a mailbox migrated from MailFlow, and its
// confirmation dialog is where the safe default (dry run, ticked) is visible.
test('settings: the conversation rebuild confirmation', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  await openSettings(page);
  await openSettingsTab(page, 'Appearance');
  await openSettingsSubTab(page, 'Layout');
  const open = page.getByTestId('conversation-rebuild-open');
  await expect(open).toBeVisible();
  await capture(page, 'settings-threading', { mode: 'workspace', require: [
    page.getByTestId('conversation-list-toggle'),
    page.getByTestId('conversation-reader-toggle'),
    open,
  ] });
  await open.click();
  const dialog = page.getByTestId('conversation-rebuild-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('conversation-rebuild-dry-run')).toBeChecked();
  await capture(page, 'settings-rebuild-confirm', { mode: 'workspace', require: [
    dialog,
    page.getByTestId('conversation-rebuild-dry-run'),
  ] });
});

// The navigation position moves the whole phone shell, so both variants are documented.
test('mobile shell: navigation docked at the top and at the bottom', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'phone shell references');
  await openMail(page, fixtureApi);
  for (const position of ['top', 'bottom']) {
    page.__preferencesOverride = { mobileNavigationPosition: position };
    await page.goto('/?list=1&reader=1', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-topbar')).toHaveAttribute('data-position', position);
    const row = page.locator(`[data-msgid="${newestDemoRowId()}"]:visible`);
    await expect(row).toBeVisible();
    // On a phone the parent row expands the thread in the list; a child row opens the
    // conversation reader, which shows the navigation position together with real content.
    await row.locator("button[aria-label*='(4)']").click();
    await row.locator(`[data-thread-row-child="${demoCopyId(3)}"]`).click();
    const reader = page.locator(`section[data-conversation-id="${demoConversationId()}"]:visible`);
    await expect(reader).toBeVisible();
    await expect(reader.locator('iframe').first()).toBeVisible();
    await settleScroll(reader, page, { pin: 0 });
    await capture(page, `mobile-navigation-${position}`, { mode: 'mail-reader', variant: 'mobile' });
  }
});
