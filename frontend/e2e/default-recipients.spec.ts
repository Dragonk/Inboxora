import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

const accountA = () => ({
  id: 'account-gmail', name: 'Defaults mailbox', email_address: 'me@gmail.test', enabled: true,
  mail_transport: 'imap_smtp', imap_host: 'imap.example.test', auth_user: 'me@gmail.test',
  default_alias_id: 'work', aliases: [{ id: 'work', name: 'Work', email: 'work@example.test' }],
  default_cc: ['cc@example.test', 'shared@example.test'], default_bcc: ['shared@example.test', 'private@example.test'],
  folder_mappings: { drafts: 'Drafts' },
});
const accountB = () => ({ ...accountA(), id: 'account-outlook', name: 'Other mailbox', email_address: 'me@outlook.test',
  default_alias_id: null, aliases: [], default_cc: ['next@example.test'], default_bcc: ['hidden@example.test'] });
const mobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
const field = (page: Page, role: 'to' | 'cc' | 'bcc') => page.getByTestId(`compose-${role}`).locator('..');
async function boot(page: Page, accounts: object[]) {
  await page.route('**/api/accounts', route => route.fulfill({ json: accounts }));
  await page.route('**/api/auth/preferences**', route => route.fulfill({ json: {
    language: 'en', threadedView: false, conversation_list_view_enabled: false,
    conversation_reader_view_enabled: false, block_remote_images: true,
  } }));
  await page.route('**/api/mail/send-limits**', route => route.fulfill({ json: { transport: 'imap_smtp', limits: {} } }));
  await page.route('**/api/search/contacts**', route => route.fulfill({ json: [] }));
  // Tests must never dispatch actual mail, even if a case unexpectedly clicks Send.
  await page.route('**/api/mail/send', route => route.fulfill({ status: 503, json: { error: 'Test send not configured' } }));
  await page.route('**/api/mail/draft', route => route.fulfill({ json: { uid: 44, folder: 'Drafts', uidValidity: 1 } }));
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}
async function settings(page: Page) {
  if (mobile(page)) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (mobile(page)) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByTestId('account-default-cc')).toBeVisible();
}
async function compose(page: Page) {
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
}
async function remove(page: Page, role: 'to' | 'cc' | 'bcc', address: string) {
  await field(page, role).getByText(address, { exact: true }).locator('..').getByRole('button').click();
}

test('account defaults persist, clear independently and reject an unconfirmed failed save', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = accountA(); let fail = true; const writes: Record<string, unknown>[] = [];
  await boot(page, [account]);
  await page.route('**/api/accounts/account-gmail', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (fail) return route.fulfill({ status: 400, json: { error: 'Invalid default recipient' } });
    account.default_cc = body.default_cc; account.default_bcc = body.default_bcc;
    return route.fulfill({ json: account });
  });
  await settings(page);
  await page.getByTestId('account-default-cc').fill('one@example.test; two@example.test');
  await page.getByTestId('account-default-bcc').fill('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(account.default_cc).toEqual(['cc@example.test', 'shared@example.test']);
  await expect(page.getByTestId('account-default-cc')).toHaveValue('one@example.test; two@example.test');
  fail = false;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByTestId('account-default-cc')).toHaveCount(0);
  expect(writes[1]).toMatchObject({ default_cc: ['one@example.test', 'two@example.test'], default_bcc: [] });
  await page.reload(); await settings(page);
  await expect(page.getByTestId('account-default-cc')).toHaveValue('one@example.test, two@example.test');
  await expect(page.getByTestId('account-default-bcc')).toHaveValue('');
});

test('visible defaults follow the account, retain manual recipients and do not reset on alias changes', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [accountA(), accountB()]); await compose(page);
  const from = page.getByTestId('compose-from');
  await expect(from).toHaveValue('alias:work:account-gmail');
  await expect(field(page, 'cc')).toContainText('cc@example.test');
  await expect(field(page, 'cc')).not.toContainText('shared@example.test');
  await expect(field(page, 'bcc')).toContainText('shared@example.test');
  await remove(page, 'cc', 'cc@example.test');
  await from.selectOption('account:account-gmail');
  await from.selectOption('alias:work:account-gmail');
  await expect(field(page, 'cc')).not.toContainText('cc@example.test');
  await page.getByTestId('compose-cc').fill('manual@example.test');
  await page.getByTestId('compose-cc').press('Enter');
  // A raw, not-yet-committed manual address already displaces its automatic duplicate.
  await page.getByTestId('compose-to').fill('Person <PRIVATE@example.test>');
  await expect(field(page, 'bcc')).not.toContainText('private@example.test');
  await from.selectOption('account:account-outlook');
  await page.getByTestId('compose-to').press('Enter');
  await expect(field(page, 'to')).toContainText('Person <PRIVATE@example.test>');
  await expect(field(page, 'cc')).toContainText('manual@example.test');
  await expect(field(page, 'cc')).toContainText('next@example.test');
  await expect(field(page, 'bcc')).not.toContainText('shared@example.test');
  await expect(field(page, 'bcc')).toContainText('hidden@example.test');
  await page.screenshot({ path: `artifacts/default-recipients-${page.viewportSize()?.width}.png` });
});

test('the send payload contains exactly the visible manual and default recipients', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [accountA()]); await compose(page);
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/mail/send', route => {
    payload = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } });
  });
  await remove(page, 'bcc', 'shared@example.test');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Recipient defaults test');
  await page.getByTestId('compose-to').fill('cc@example.test');
  await expect(field(page, 'cc')).not.toContainText('cc@example.test');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => payload).toMatchObject({ accountId: 'account-gmail', aliasId: 'work',
    to: ['cc@example.test'], cc: [], bcc: ['private@example.test'] });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('an untouched blank composer with defaults does not autosave a draft', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [accountA()]); await compose(page);
  let drafts = 0;
  await page.route('**/api/mail/draft', route => { drafts++; return route.fulfill({ json: { uid: 44, folder: 'Drafts' } }); });
  await page.clock.install(); await page.clock.fastForward(60_000);
  await expect(field(page, 'bcc')).toContainText('private@example.test');
  expect(drafts).toBe(0);
});

test('opening a saved draft preserves its recipients without reapplying current defaults', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/accounts/account-gmail/folders', route => route.fulfill({ json: [
    { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
    { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
  ] }));
  const draft = { id: 'saved-draft', account_id: 'account-gmail', folder: 'Drafts', uid: 44,
    subject: 'Saved recipient choices', is_read: true, from_email: 'me@gmail.test',
    to_addresses: ['recipient@example.test'], cc_addresses: ['saved@example.test'],
    draft_bcc_addresses: [], date: '2026-09-28T09:00:00Z' };
  await boot(page, [accountA()]);
  await page.route('**/api/mail/messages**', route => {
    if (route.request().url().includes('/body')) return route.fulfill({ json: { text: 'Saved body', attachments: [] } });
    return route.fulfill({ json: { messages: [draft], total: 1 } });
  });
  if (mobile(page)) await page.getByTestId('mobile-topbar-menu').click();
  const account = page.locator('[data-account-id="account-gmail"]').first();
  await account.getByRole('button').first().click();
  await account.getByText('Drafts', { exact: true }).click();
  await page.locator('[data-msgid="saved-draft"]:visible').click();
  await expect(page.getByTestId('compose-from')).toHaveValue('account:account-gmail');
  await expect(field(page, 'to')).toContainText('recipient@example.test');
  await expect(field(page, 'cc')).toContainText('saved@example.test');
  await expect(field(page, 'cc')).not.toContainText('cc@example.test');
  await expect(page.getByTestId('compose-bcc')).toHaveCount(0);
});

test('reply mode changes keep account defaults and respect removal', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [accountA()]);
  await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
  await page.getByRole('button', { name: mobile(page) ? 'Reply' : 'Reply (R)', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
  await expect(field(page, 'bcc')).toContainText('private@example.test');
  await remove(page, 'bcc', 'private@example.test');
  if (!mobile(page)) await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await page.getByText('Reply All', { exact: true }).last().click();
  await expect(field(page, 'bcc')).toContainText('shared@example.test');
  await expect(field(page, 'bcc')).not.toContainText('private@example.test');
});

test('long default lists leave the editor and send control reachable', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const account = accountA();
  account.default_cc = Array.from({ length: 50 }, (_, i) => `cc${i}@example.test`);
  account.default_bcc = Array.from({ length: 50 }, (_, i) => `bcc${i}@example.test`);
  await boot(page, [account]); await compose(page);
  await expect(field(page, 'cc').locator(':scope > span')).toHaveCount(50);
  await expect(field(page, 'bcc').locator(':scope > span')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Body remains editable');
  await expect(page.locator('.tiptap-compose [contenteditable="true"]')).toHaveText('Body remains editable');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
});
