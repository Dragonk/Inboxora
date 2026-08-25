import { test, expect } from './fixtures.js';

test('settings show exactly two CE controls with OFF/ON cards', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  // Use the real shell navigation. On mobile the sidebar is a drawer, so open
  // it through the native menu button before selecting the profile/settings item.
  const menuButton = page.getByTestId('mobile-menu');
  if (await menuButton.count()) await menuButton.click();
  const drawer = page.getByTestId('mobile-sidebar');
  const isMobile = await page.getByTestId('mobile-menu').count();
  const profile = isMobile ? drawer.getByText(/e2e@example\.test/i).first() : page.getByText(/e2e@example\.test/i).first();
  if (isMobile) {
    await profile.evaluate(el => el.parentElement?.click());
  } else {
    await profile.click();
  }
  const settingsItem = isMobile ? page.getByTestId('mobile-settings') : page.getByText(/^Ustawienia$|^Settings$/i).first();
  if (isMobile) await expect(settingsItem).toBeVisible();
  if (isMobile) {
    await settingsItem.evaluate(el => el.click());
  } else {
    await settingsItem.click();
  }
  await page.getByText(/^Wygląd$|^Appearance$/i).click();
  await page.getByRole('button', { name: /^Układ$|^Layout$/i }).click();

  await expect(page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i)).toBeVisible();
  await expect(page.getByText(/^Czytnik rozmowy$|^Conversation reader$/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Wyłączone.*Każda wiadomość jest wyświetlana osobno|Disabled.*Open only the selected message/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Włączone.*Odpowiedzi grupowane w rozmowy|Enabled.*Replies grouped into conversations/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Wyłączony.*Otwieraj tylko wybraną wiadomość|Disabled.*Open only the selected message/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Włączony.*Pokazuj całą rozmowę w panelu wiadomości|Enabled.*Show the entire conversation in the message pane/i })).toBeVisible();

  // There must be exactly two CE section headings and no third grouping control.
  await expect(page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i)).toHaveCount(1);
  await expect(page.getByText(/^Czytnik rozmowy$|^Conversation reader$/i)).toHaveCount(1);
  const groupingHeading = page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i);
  await groupingHeading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/settings-ce-controls.png', fullPage: false });
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });
});
