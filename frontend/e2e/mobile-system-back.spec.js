import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';

const mailbox = page => page.getByTestId('message-list-scroll');
async function back(page, native) {
  if (native) expect(await page.evaluate(() => window.__inboxoraHandleAndroidBack())).toBe(true);
  else await page.goBack();
}
async function boot(page, fixtureApi, reader = true) {
  await fixtureApi;
  await setupV3(page);
  page.__conversationMatrix = `0${Number(reader)}`;
  await page.goto('/');
  await expect(page.locator('[data-ce-reader-enabled]:visible')).toHaveAttribute('data-ce-reader-enabled', String(reader));
}
for (const native of [false, true]) {
  const mode = native ? 'Android bridge' : 'PWA history';
  test.describe(mode, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium-mobile-390', 'mobile Back');
      if (!native) await page.addInitScript(() => {
        const matchMedia = window.matchMedia.bind(window);
        window.matchMedia = query => query === '(display-mode: standalone)' ? { matches: true } : matchMedia(query);
      });
    });
    for (const reader of [false, true]) test(`one gesture closes the ${reader ? 'conversation' : 'single'} reader across repeated opens`, async ({ page, fixtureApi }) => {
      await boot(page, fixtureApi, reader);
      for (let i = 0; i < 3; i++) {
        await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
        await expect(page.getByTestId('message-pane-toolbar').first()).toBeVisible();
        if (reader) await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(1);
        await back(page, native);
        await expect(mailbox(page)).toBeVisible();
        await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
      }
      await expect.poll(() => page.evaluate(() => history.state?.inboxoraBack || null)).toBe(null);
      expect(await page.evaluate(() => window.__inboxoraHandleAndroidBack())).toBe(false);
    });
    test('contacts detail, editor and books close before the contacts module', async ({ page, fixtureApi }) => {
      await boot(page, fixtureApi);
      await navigateModule(page, 'contacts');
      await page.getByRole('button', { name: 'Anna Kowalska', exact: true }).click();
      await page.getByRole('button', { name: 'Edytuj', exact: true }).click();
      await back(page, native);
      await expect(page.getByRole('button', { name: 'Edytuj', exact: true })).toBeVisible();
      await back(page, native);
      await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
      await page.getByTestId('contacts-address-books').click();
      await back(page, native);
      await expect(page.getByTestId('contacts-books-dialog')).toHaveCount(0);
      await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
      await back(page, native);
      await expect(mailbox(page)).toBeVisible();
    });
    test('Back protects an unsaved reply and returns through its reader', async ({ page, fixtureApi }) => {
      await boot(page, fixtureApi);
      await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
      await expect(page.getByTestId('message-pane-toolbar').first()).toBeVisible();
      await page.getByTestId('mobile-topbar').getByRole('button', { name: 'Napisz' }).click();
      const subject = page.getByPlaceholder('Dodaj temat', { exact: true });
      await subject.fill('Treść do zachowania');
      await back(page, native);
      await expect(page.getByText('Zapisać tę wersję roboczą?', { exact: true })).toBeVisible();
      await back(page, native);
      await expect(subject).toHaveValue('Treść do zachowania');
      await expect(page.getByText('Zapisać tę wersję roboczą?', { exact: true })).toHaveCount(0);
      await back(page, native);
      await page.getByRole('button', { name: 'Odrzuć', exact: true }).last().click();
      await expect(subject).toHaveCount(0);
      await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(1);
      await back(page, native);
      await expect(mailbox(page)).toBeVisible();
    });
    test('calendar nested dialogs, settings and drawer close one layer at a time', async ({ page, fixtureApi }) => {
      await boot(page, fixtureApi);
      await navigateModule(page, 'calendar');
      await page.getByTestId('calendar-header-new').click();
      await expect(page.getByTestId('calendar-event-dialog')).toBeVisible();
      await back(page, native);
      await expect(page.getByTestId('calendar-event-dialog')).toHaveCount(0);
      await page.getByTestId('calendar-mobile-panel').click();
      await page.getByRole('button', { name: 'Zarządzaj źródłami' }).click();
      await back(page, native);
      await expect(page.getByTestId('calendar-mobile-dock')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await back(page, native);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByTestId('mobile-topbar-menu').click();
      await page.getByTestId('sidebar-user-menu').click();
      await page.getByTestId('mobile-settings').click();
      await expect(page.locator('.admin-panel')).toBeVisible();
      await back(page, native);
      await expect(page.locator('.admin-panel')).toHaveCount(0);
      await expect(page.getByTestId('calendar-page')).toBeVisible();
      await page.getByTestId('mobile-topbar-menu').click();
      await back(page, native);
      await expect(page.getByTestId('calendar-page')).toBeVisible();
      await back(page, native);
      await expect(mailbox(page)).toBeVisible();
    });
  });
}

test('UI Back consumes its history entry and a later system Back leaves the root', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'mobile history');
  await page.goto('/?previous-page=1');
  await boot(page, fixtureApi);
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  await expect(page.getByTestId('message-pane-toolbar').first()).toBeVisible();
  await page.getByRole('button', { name: 'Wstecz', exact: true }).click();
  await expect(mailbox(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state?.inboxoraBack || null)).toBe(null);
  await page.goBack();
  await expect(page).toHaveURL(/previous-page=1/);
});
