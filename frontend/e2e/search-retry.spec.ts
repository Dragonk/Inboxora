import { test, expect } from './fixtures.ts';

const result = {
  id: 'search-hit-monika', uid: 77, folder: 'INBOX', subject: 'Spotkanie z Moniką',
  from_name: 'Monika Kowalska', from_email: 'monika@example.test', to_addresses: [], cc_addresses: [],
  date: '2026-09-29T10:00:00Z', snippet: 'Potwierdzenie spotkania', is_read: true, is_starred: false,
  has_attachments: false, account_id: 'account-gmail', account_name: 'Gmail fixture', account_email: 'me@gmail.test',
};

test('a provider timeout continues automatically instead of becoming a false no-result state', async ({ page, fixtureApi }) => {
  await fixtureApi; page.__languageOverride = 'en';
  let calls = 0;
  await page.route('**/api/search?*', route => {
    calls += 1;
    if (calls === 1) return route.fulfill({ json: {
      messages: [], nextOffset: null, partial: true, retryablePartial: true,
      providerErrors: [{ accountId: 'account-gmail', code: 'SEARCH_INCOMPLETE', error: 'deadline' }],
    } });
    return route.fulfill({ json: { messages: [result], nextOffset: null, partial: false, retryablePartial: false } });
  });
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await page.getByPlaceholder('Search…').fill('monika');
  await expect(page.getByText(/mail servers are still being searched/i)).toBeVisible();
  await expect(page.getByText('No results found', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Spotkanie z Moniką', { exact: true })).toBeVisible({ timeout: 5000 });
  expect(calls).toBe(2);
  await expect(page.getByText(/mail servers are still being searched/i)).toHaveCount(0);
});

test('a non-retryable provider failure stays partial and requires an explicit refresh', async ({ page, fixtureApi }) => {
  await fixtureApi; page.__languageOverride = 'en';
  let calls = 0;
  await page.route('**/api/search?*', route => {
    calls += 1;
    return route.fulfill({ json: {
      messages: [], nextOffset: null, partial: true, retryablePartial: false,
      providerErrors: [{ accountId: 'account-gmail', code: 'PROVIDER_AUTH_REQUIRED', error: 'Reconnect account' }],
    } });
  });
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await page.getByPlaceholder('Search…').fill('monika');
  await expect(page.getByText(/search results are incomplete/i)).toBeVisible();
  await expect(page.getByText('No results found', { exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(calls).toBe(1);
});
