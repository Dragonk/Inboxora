import { test, expect } from './fixtures.ts';

test('settings expose two independent conversation switches', async ({ page, fixtureApi }) => {
  page.__conversationMatrix = '00';
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByTestId('admin-tab-appearance').click();
  await page.getByRole('button', { name: /^Układ$|^Layout$/i }).click();

  await expect(page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i)).toBeVisible();
  await expect(page.getByText(/^Czytnik rozmowy$|^Conversation reader$/i)).toBeVisible();
  const list = page.getByTestId('conversation-list-toggle');
  const reader = page.getByTestId('conversation-reader-toggle');
  await expect(list).toHaveAttribute('role', 'group');
  await expect(reader).toHaveAttribute('role', 'group');
  await expect(list.getByRole('button', { name: /^Wyłączone/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(reader.getByRole('button', { name: /^Wyłączony/ })).toHaveAttribute('aria-pressed', 'true');
  await list.getByRole('button', { name: /^Włączone/ }).click();
  await expect(list.getByRole('button', { name: /^Włączone/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(reader.getByRole('button', { name: /^Wyłączony/ })).toHaveAttribute('aria-pressed', 'true');
  await reader.getByRole('button', { name: /^Włączony/ }).click();
  await expect(reader.getByRole('button', { name: /^Włączony/ })).toHaveAttribute('aria-pressed', 'true');
  await list.getByRole('button', { name: /^Wyłączone/ }).click();
  await expect(reader.getByRole('button', { name: /^Włączony/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByRole('button', { name: /^Wyłączone/ })).toHaveAttribute('aria-pressed', 'true');

  // There must be exactly two CE section headings and no third grouping control.
  await expect(page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i)).toHaveCount(1);
  await expect(page.getByText(/^Czytnik rozmowy$|^Conversation reader$/i)).toHaveCount(1);
  const groupingHeading = page.getByText(/^Grupowanie rozmów$|^Group messages into conversations$/i);
  await groupingHeading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/settings-ce-controls.png', fullPage: false });
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });
});
