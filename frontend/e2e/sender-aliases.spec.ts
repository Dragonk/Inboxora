import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

const createAccount = () => ({
  id: 'account-gmail', name: 'Sender fixture', email_address: 'primary@example.test',
  enabled: true, mail_transport: 'imap_smtp', default_alias_id: null as string | null,
  aliases: [
    { id: 'work', name: 'Work', email: 'work@example.test' },
    { id: 'billing', name: 'Billing', email: 'billing@example.test' },
  ],
});
async function openSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/).first().click();
}
async function openAliases(page: Page) {
  const panel = page.locator('.admin-panel');
  await panel.getByRole('button', { name: /^Edytuj$|^Edit$/ }).click();
  await panel.getByRole('tab', { name: /^Aliasy$|^Aliases$/ }).click();
  await expect(page.getByTestId('sender-addresses')).toBeVisible();
}
async function newMessage(page: Page) {
  // Use the mobile header action directly; opening its sidebar would cover it.
  await page.getByRole('button', { name: /^Napisz$|^Compose$/ }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
}

test('primary address is protected; default selection persists and seeds new messages', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = createAccount();
  const writes: unknown[] = [];
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/default-sender', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    account.default_alias_id = body.aliasId;
    return route.fulfill({ json: { id: account.id, default_alias_id: account.default_alias_id } });
  });
  await page.goto('/'); await openSettings(page); await openAliases(page);
  const list = page.getByTestId('sender-addresses');
  await expect(list.getByRole('radio')).toHaveCount(3);
  await expect(page.getByTestId('sender-primary').getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('sender-primary').getByRole('button')).toHaveCount(0);
  // Selection changes only after the server confirms the asynchronous save.
  await page.getByTestId('sender-alias-work').getByRole('radio').click();
  await expect(page.getByTestId('sender-alias-work').getByRole('radio')).toBeChecked();
  await expect(list.locator('input:checked')).toHaveCount(1);
  expect(writes).toEqual([{ aliasId: 'work' }]);
  await page.screenshot({ path: `artifacts/sender-addresses-${page.viewportSize()?.width}.png` });
  await page.reload(); await openSettings(page); await openAliases(page);
  await expect(page.getByTestId('sender-alias-work').getByRole('radio')).toBeChecked();
  await page.reload(); await newMessage(page);
  const from = page.getByTestId('compose-from');
  await expect(from).toHaveValue('alias:work:account-gmail');
  await from.selectOption('account:account-gmail');
  await expect(from).toHaveValue('account:account-gmail');
  await from.selectOption('alias:billing:account-gmail');
  await expect(from).toHaveValue('alias:billing:account-gmail');
  expect(account.default_alias_id).toBe('work');
});

test('deleting the default alias restores primary without removing the mailbox', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = createAccount(); account.default_alias_id = 'work';
  const deleted: string[] = [];
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/aliases/work', route => {
    expect(route.request().method()).toBe('DELETE'); deleted.push('work');
    account.aliases = account.aliases.filter(alias => alias.id !== 'work'); account.default_alias_id = null;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/'); await openSettings(page); await openAliases(page);
  await page.getByTestId('sender-alias-work').getByRole('button', { name: /^Usuń$|^Delete$/ }).click();
  await page.getByRole('button', { name: /^Usuń$|^Delete$/ }).last().click();
  await expect(page.getByTestId('sender-alias-work')).toHaveCount(0);
  await expect(page.getByTestId('sender-primary').getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('sender-primary')).toContainText('primary@example.test');
  expect(deleted).toEqual(['work']);
  await page.reload(); await newMessage(page);
  await expect(page.getByTestId('compose-from')).toHaveValue('account:account-gmail');
});

test('a failed save is visible and retryable without selecting an unconfirmed sender', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = createAccount(); let writes = 0;
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/default-sender', route => {
    writes += 1;
    if (writes === 1) return route.fulfill({ status: 409, json: { error: 'Selected sender alias is unavailable' } });
    account.default_alias_id = route.request().postDataJSON().aliasId;
    return route.fulfill({ json: { id: account.id, default_alias_id: account.default_alias_id } });
  });
  await page.goto('/'); await openSettings(page); await openAliases(page);
  await page.getByTestId('sender-alias-work').getByRole('radio').click();
  await expect(page.getByRole('alert')).toContainText('Selected sender alias is unavailable');
  await expect(page.getByTestId('sender-primary').getByRole('radio')).toBeChecked();
  // Selection changes only after the server confirms the asynchronous save.
  await page.getByTestId('sender-alias-work').getByRole('radio').click();
  await expect(page.getByTestId('sender-alias-work').getByRole('radio')).toBeChecked();
  expect(writes).toBe(2);
});

test('a late save cannot overwrite a remounted sender settings view', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = createAccount();
  let pending = false; let release: () => void = () => { throw new Error('Release not initialized'); };
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/accounts', route => route.fulfill({ json: [account] }));
  await page.route('**/api/accounts/account-gmail/default-sender', async route => {
    pending = true; await held;
    return route.fulfill({ json: { id: account.id, default_alias_id: 'work' } });
  });
  await page.goto('/'); await openSettings(page); await openAliases(page);
  await page.getByTestId('sender-alias-work').getByRole('radio').click();
  await expect.poll(() => pending).toBe(true);
  await page.getByTestId('admin-tab-appearance').click();
  await page.getByTestId('admin-tab-accounts').click(); await openAliases(page);
  await expect(page.getByTestId('sender-primary').getByRole('radio')).toBeChecked();
  const response = page.waitForResponse(item => item.request().method() === 'PUT' && item.url().endsWith('/default-sender'));
  release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('sender-primary').getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('sender-alias-work').getByRole('radio')).not.toBeChecked();
});
