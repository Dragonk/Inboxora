import { test, expect } from './fixtures.js';

// The appearance tab must expose a theme mode plus one independent default for the
// light appearance and one for the dark appearance, and the active theme has to
// follow that selection. Ink is the shipped light default, Dark ink the dark one.
const PREFERENCES = {
  theme: 'ink',
  themeMode: 'system',
  themeLight: 'ink',
  themeDark: 'dark_ink',
};

async function openAppearance(page) {
  await page.goto('/');
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByText(/^Wygląd$|^Appearance$/i).click();
}

const activeTheme = (page) => page.evaluate(
  () => document.documentElement.getAttribute('data-mailflow-theme'),
);

test('separate light and dark defaults drive the active theme', async ({ page, fixtureApi }) => {
  await fixtureApi;
  page.__preferencesOverride = PREFERENCES;
  await openAppearance(page);

  await expect(page.getByRole('group', { name: /Tryb motywu|Theme mode/i })).toBeVisible();
  await expect(page.getByTestId('theme-default-light')).toBeVisible();
  await expect(page.getByTestId('theme-default-dark')).toBeVisible();

  // Each appearance owns its own grid, so Dark ink and Ink appear exactly once.
  await expect(page.getByTestId('theme-default-dark').getByRole('button', { name: /Dark ink/ })).toHaveCount(1);
  await expect(page.getByTestId('theme-default-light').getByRole('button', { name: /^Ink / })).toHaveCount(1);

  // "Follow system" under a light OS preference resolves to the light default.
  await page.getByRole('button', { name: /Zgodnie z systemem|Follow system/i }).click();
  await expect.poll(() => activeTheme(page)).toBe('ink');

  // Forcing dark resolves to the *dark* default, not to the legacy "dark" theme.
  await page.getByRole('button', { name: /Zawsze ciemny|Always dark/i }).click();
  await expect.poll(() => activeTheme(page)).toBe('dark_ink');

  // Forcing light goes back to the light default.
  await page.getByRole('button', { name: /Zawsze jasny|Always light/i }).click();
  await expect.poll(() => activeTheme(page)).toBe('ink');

  // Re-pointing the dark default changes what the dark appearance renders.
  await page.getByRole('button', { name: /Zawsze ciemny|Always dark/i }).click();
  await expect.poll(() => activeTheme(page)).toBe('dark_ink');
  await page.getByRole('button', { name: /Nord/ }).click();
  await expect.poll(() => activeTheme(page)).toBe('nord');
});

test('a legacy single theme preference is preserved as an explicit choice', async ({ page, fixtureApi }) => {
  await fixtureApi;
  // Only the pre-existing preference key is present — no mode, no per-tone defaults.
  page.__preferencesOverride = { theme: 'gruvbox' };
  await page.goto('/');

  await expect.poll(() => activeTheme(page)).toBe('gruvbox');

  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByText(/^Wygląd$|^Appearance$/i).click();

  // Gruvbox is dark, so it landed in the dark slot and forced the dark appearance.
  await expect(page.getByRole('button', { name: /Zawsze ciemny|Always dark/i }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Gruvbox/ })).toHaveAttribute('aria-pressed', 'true');
});
