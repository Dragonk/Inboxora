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
/** Provision isolated browser mocks, optionally delaying account loading to exercise startup races. */
async function boot(page: Page, accounts: object[], options: { accountsGate?: Promise<void>; url?: string; waitForList?: boolean } = {}) {
  await page.route('**/api/accounts', async route => {
    await options.accountsGate;
    return route.fulfill({ json: accounts });
  });
  await page.route('**/api/auth/preferences**', route => route.fulfill({ json: {
    language: 'en', threadedView: false, conversation_list_view_enabled: false,
    conversation_reader_view_enabled: false, block_remote_images: true,
  } }));
  await page.route('**/api/mail/send-limits**', route => route.fulfill({ json: { transport: 'imap_smtp', limits: {} } }));
  await page.route('**/api/search/contacts**', route => route.fulfill({ json: [] }));
  // Tests must never dispatch actual mail, even if a case unexpectedly clicks Send.
  await page.route('**/api/mail/send', route => route.fulfill({ status: 503, json: { error: 'Test send not configured' } }));
  await page.route('**/api/mail/draft', route => route.fulfill({ json: { uid: 44, folder: 'Drafts', uidValidity: 1 } }));
  await page.goto(options.url ?? '/');
  if (options.waitForList !== false) await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}
/** Open the account settings editor using the active desktop or mobile navigation. */
async function settings(page: Page) {
  if (mobile(page)) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (mobile(page)) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByTestId('account-default-cc')).toBeVisible();
}
/** Open a new message and wait for the real sender selector to become available. */
async function compose(page: Page) {
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
}
/** Remove the specified visible recipient chip through its real UI control. */
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

for (const transport of ['imap_smtp', 'gmail_api', 'microsoft_graph']) {
  test(`${transport}: default CC and BCC settings follow the signature editor`, async ({ page, fixtureApi }) => {
    await fixtureApi;
    const account = { ...accountA(), mail_transport: transport, signature: '<p>Original signature</p>' };
    await boot(page, [account]);
    await settings(page);
    const editor = page.locator('.au-mail-editor');
    await expect(editor.locator('[contenteditable="true"]')).toHaveText('Original signature');
    const order = await editor.evaluate(root => {
      const signature = root.querySelector('[contenteditable="true"]')?.parentElement;
      const cc = root.querySelector('[data-testid="account-default-cc"]');
      const bcc = root.querySelector('[data-testid="account-default-bcc"]');
      if (!signature || !cc || !bcc) throw new Error('Signature or default-recipient field is missing');
      return {
        signatureBeforeCc: Boolean(signature.compareDocumentPosition(cc) & Node.DOCUMENT_POSITION_FOLLOWING),
        ccBelowSignature: cc.getBoundingClientRect().top >= signature.getBoundingClientRect().bottom,
        bccBelowCc: bcc.getBoundingClientRect().top >= cc.getBoundingClientRect().bottom,
      };
    });
    expect(order).toEqual({ signatureBeforeCc: true, ccBelowSignature: true, bccBelowCc: true });
    await expect(page.getByTestId('account-default-cc')).toHaveValue(account.default_cc.join(', '));
    await expect(page.getByTestId('account-default-bcc')).toHaveValue(account.default_bcc.join(', '));
  });
}

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

for (const entry of ['compose action', 'mailto'] as const) {
  test(`${entry} opened before account loading waits for the configured sender and recipients`, async ({ page, fixtureApi }) => {
    await fixtureApi;
    let releaseAccounts: () => void = () => { throw new Error('Account gate was not initialized'); };
    const accountsGate = new Promise<void>(resolve => { releaseAccounts = resolve; });
    const url = entry === 'mailto'
      ? '/?mailto=' + encodeURIComponent('mailto:receiver@example.test?subject=Startup&cc=manual@example.test&bcc=blind@example.test')
      : '/';
    try {
      await boot(page, [accountA()], { accountsGate, url, waitForList: false });
      if (entry === 'compose action') await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
      // Observe the explicit waiting branch rather than racing a negative DOM assertion.
      await expect(page.getByTestId('compose-accounts-loading')).toHaveCount(1);
      await expect(page.getByTestId('compose-from')).toHaveCount(0);
    } finally {
      releaseAccounts();
    }
    await expect(page.getByTestId('compose-accounts-loading')).toHaveCount(0);
    await expect(page.getByTestId('compose-from')).toHaveValue('alias:work:account-gmail');
    await expect(field(page, 'cc')).toContainText('cc@example.test');
    await expect(field(page, 'bcc')).toContainText('shared@example.test');
    await expect(field(page, 'bcc')).toContainText('private@example.test');
    if (entry === 'mailto') {
      await expect(field(page, 'to')).toContainText('receiver@example.test');
      await expect(field(page, 'cc')).toContainText('manual@example.test');
      await expect(field(page, 'bcc')).toContainText('blind@example.test');
      await expect(page.getByPlaceholder(/^(Add a subject|Subject)$/)).toHaveValue('Startup');
    }
  });
}

test('partial delivery retries preserve rejected recipients across sender account and alias changes', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [accountA(), accountB()]); await compose(page);
  const payloads: Record<string, unknown>[] = [];
  await page.route('**/api/mail/send', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ json: payloads.length === 1
      ? { ok: true, partialDelivery: true, rejected: ['cc@example.test', 'private@example.test'] }
      : { ok: true } });
  });
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Partial delivery retry');
  await page.getByTestId('compose-to').fill('accepted@example.test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(1);
  await expect(field(page, 'to')).not.toContainText('accepted@example.test');
  await expect(field(page, 'bcc')).not.toContainText('shared@example.test');
  await expect(field(page, 'cc')).toContainText('cc@example.test');
  await expect(field(page, 'bcc')).toContainText('private@example.test');
  const from = page.getByTestId('compose-from');
  for (const sender of ['account:account-outlook', 'alias:work:account-gmail', 'account:account-outlook']) {
    await from.selectOption(sender);
    await expect(field(page, 'cc')).toContainText('cc@example.test');
    await expect(field(page, 'bcc')).toContainText('private@example.test');
    await expect(field(page, 'cc')).not.toContainText('next@example.test');
    await expect(field(page, 'bcc')).not.toContainText('hidden@example.test');
    await expect(field(page, 'bcc')).not.toContainText('shared@example.test');
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1]).toMatchObject({ accountId: 'account-outlook', to: [],
    cc: ['cc@example.test'], bcc: ['private@example.test'] });
  expect(payloads[1]).not.toHaveProperty('aliasId');
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

for (const outcome of ['partial', 'failure'] as const) {
  test(`recipient editing is locked during sending and restored after ${outcome}`, async ({ page, fixtureApi }) => {
    await fixtureApi; await boot(page, [accountA(), accountB()]); await compose(page);
    let releaseSend: () => void = () => { throw new Error('Send gate was not initialized'); };
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
    let submitted = false;
    await page.route('**/api/mail/send', async route => {
      submitted = true;
      await sendGate;
      return outcome === 'partial'
        ? route.fulfill({ json: { partialDelivery: true, rejected: ['cc@example.test', 'private@example.test'] } })
        : route.fulfill({ status: 503, json: { error: 'Temporary test failure' } });
    });
    await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Pending send controls');
    await page.getByTestId('compose-to').fill('accepted@example.test');
    try {
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => submitted).toBe(true);
      await expect(page.getByTestId('compose-from')).toBeDisabled();
      for (const role of ['to', 'cc', 'bcc'] as const) {
        await expect(page.getByTestId(`compose-${role}`)).toBeDisabled();
      }
      const copyChip = field(page, 'cc').getByText('cc@example.test', { exact: true }).locator('..');
      await expect(copyChip.getByRole('button')).toBeDisabled();
      // Chip spans are not native inputs: double-click/context-menu paths must also be guarded.
      await copyChip.dispatchEvent('dblclick');
      await copyChip.dispatchEvent('contextmenu');
      await expect(field(page, 'cc')).toContainText('cc@example.test');
      await expect(page.getByTestId('compose-cc')).toHaveValue('');
      await expect(page.getByText('Copy address', { exact: true })).toHaveCount(0);
    } finally {
      releaseSend();
    }
    await expect(page.getByTestId('compose-from')).toBeEnabled();
    for (const role of ['to', 'cc', 'bcc'] as const) {
      await expect(page.getByTestId(`compose-${role}`)).toBeEnabled();
    }
    await expect(field(page, 'cc')).toContainText('cc@example.test');
    await expect(field(page, 'bcc')).toContainText('private@example.test');
    await page.getByTestId('compose-cc').fill('added-after-response@example.test');
    await page.getByTestId('compose-cc').press('Enter');
    await expect(field(page, 'cc')).toContainText('added-after-response@example.test');
  });
}
