import { test, expect } from './fixtures.ts';

for (const change of ['read-only', 'removed']) {
  test(`new contact from all-visible retains its target when ${change} at save`, async ({ page, fixtureApi }) => {
    await fixtureApi;
    let changed = false;
    let writes = 0;
    await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: [
      { id: 'ro', name: 'Read only', source: 'local', read_only: true },
      ...(!changed || change !== 'removed' ? [{ id: 'a', name: 'Target A', source: 'local', read_only: changed }] : []),
      { id: 'b', name: 'Target B', source: 'local', read_only: false },
    ] } }));
    await page.route('**/api/contacts', route => {
      if (route.request().method() === 'POST') { writes++; return route.fulfill({ json: { id: 'new' } }); }
      return route.fallback();
    });
    await page.goto('/');
    const mobile = page.viewportSize()!.width < 768;
    if (mobile) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId(mobile ? 'contacts-nav-mobile' : 'contacts-nav-primary').click();
    if (mobile) await page.getByTestId('contacts-header-new').click();
    else await page.locator('.contacts-heading button').click();
    const target = page.getByTestId('contacts-new-target').locator('select');
    await expect(target).toHaveValue('a');
    await page.locator('#contact-firstName').fill('New person');
    changed = true;
    await page.locator('.contacts-form').getByRole('button', { name: /^Zapisz$|^Save$/ }).click();
    await expect(page.locator('.contacts-form').getByRole('alert')).toBeVisible();
    await expect(target).toHaveValue('a');
    expect(writes).toBe(0);
  });
}

for (const provider of ['google', 'microsoft']) {
  test(`${provider} book sync stays account-scoped and reports HTTP200 failure/success`, async ({ page, fixtureApi }) => {
    await fixtureApi;
    const books = ['a', 'b', 'unknown'].map(id => ({ id, name: `Book ${id}`, source: provider, provider, account_email: 'same@example.com', account_id: id === 'unknown' ? null : `account-${id}`, connection_id: id === 'unknown' ? null : `connection-${id}`, read_only: true, visible: true }));
    await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: books } }));
    await page.route(`**/api/contacts/providers/${provider}/status`, route => route.fulfill({ json: { configured: true, connected: true, books: [] } }));
    const requests: string[] = [];
    let succeed = false;
    let pending: Promise<void> | null = null;
    await page.route('**/api/accounts/*/provider-features/contacts/sync', async route => {
      requests.push(route.request().url());
      if (pending) await pending;
      return route.fulfill({ json: succeed ? { state: 'success', result: { created: 7, updated: 3, deleted: 2 } } : { state: 'partial', result: { created: 1, error: { code: 'INSUFFICIENT_SCOPES', missingScopes: ['Contacts.ReadWrite'] } } } });
    });
    let globalCalls = 0;
    await page.route('**/api/contacts/providers/*/sync', route => { globalCalls++; return route.fulfill({ json: {} }); });
    await page.goto('/');
    const mobile = page.viewportSize()!.width < 768;
    if (mobile) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId(mobile ? 'contacts-nav-mobile' : 'contacts-nav-primary').click();
    if (mobile) await page.getByTestId('contacts-address-books').click();
    await page.getByTestId('contacts-manage-books').click();
    const manager = page.getByTestId('contacts-books-manager');
    await expect(manager.getByTestId('contacts-manager-book-group')).toHaveCount(3);
    await manager.getByTestId('contacts-manager-book-a').click();
    const sync = manager.getByTestId(`contacts-manager-sync-${provider}`);
    await sync.click();
    const notice = page.getByTestId('contacts-settings').getByRole('status');
    await expect(notice).toContainText('Contacts.ReadWrite');
    expect(requests).toEqual([expect.stringContaining('/accounts/account-a/provider-features/contacts/sync')]);
    succeed = true;
    await sync.click();
    await expect(notice).not.toContainText('Contacts.ReadWrite');
    await expect(notice).toContainText('7');
    if (mobile) await manager.getByTestId('contacts-manager-back').click();
    await manager.getByTestId('contacts-manager-book-unknown').click();
    await expect(sync).toBeDisabled();
    expect(requests).toHaveLength(2);
    if (mobile) await manager.getByTestId('contacts-manager-back').click();
    await manager.getByTestId('contacts-manager-book-a').click();
    let release!: () => void;
    pending = new Promise<void>(resolve => { release = resolve; });
    await sync.click();
    await expect.poll(() => requests.length).toBe(3);
    if (mobile) await manager.getByTestId('contacts-manager-back').click();
    await manager.getByTestId('contacts-manager-book-b').click();
    const completed = page.waitForResponse(response => response.url().includes('/accounts/account-a/provider-features/contacts/sync'));
    release();
    await completed;
    await expect(notice).toHaveCount(0);
    await expect(sync).toBeEnabled();
    expect(globalCalls).toBe(0);
  });
}
