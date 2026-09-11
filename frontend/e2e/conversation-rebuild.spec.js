import { test, expect } from './fixtures.js';

// Rebuilding conversations is the step that groups an existing mailbox (for
// example one migrated from MailFlow) into threads. It rewrites how mail is
// grouped, so the settings surface must always confirm first, must start in
// dry-run mode, and must report what happened.
//
// The API is stubbed here, so these tests assert the interface contract rather
// than the threading algorithm, which the conversation-engine specs cover.

// The rebuild action lives beside the two threading switches, which are in the
// Appearance tab's Layout sub-tab rather than on its default Theme sub-tab.
const openAppearance = async page => {
  await page.goto('/');
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByText(/^Wygląd$|^Appearance$/i).first().click();
  await page.locator('.admin-panel').getByRole('button', { name: /^Układ$|^Layout$/i }).first().click();
};

/** Records the rebuild calls and answers them like the backend does. */
const stubRebuild = async (page, { status: endStatus = 'complete', result = { scanned: 40, would_change: 12, changed: 0, dryRun: true } } = {}) => {
  const calls = { start: [], status: 0 };
  await page.route('**/api/mail/conversations/rebuild', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls.start.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { jobId: 'job-1', status: 'queued' } });
  });
  await page.route('**/api/mail/conversations/rebuild/*', async route => {
    calls.status += 1;
    return route.fulfill({ json: { jobId: 'job-1', status: endStatus, result, error: endStatus === 'failed' ? 'Fixture failure' : null } });
  });
  return calls;
};

test('the rebuild action confirms before doing anything and only then calls the API', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const calls = await stubRebuild(page);
  await openAppearance(page);

  const open = page.getByTestId('conversation-rebuild-open');
  await expect(open).toBeVisible();
  await open.click();

  // The dialog is the gate: nothing has been requested yet.
  const dialog = page.getByTestId('conversation-rebuild-dialog');
  await expect(dialog).toBeVisible();
  expect(calls.start).toHaveLength(0);

  // Dry run is the default, so confirming the dialog as-is writes nothing.
  await expect(page.getByTestId('conversation-rebuild-dry-run')).toBeChecked();
  await expect(page.getByTestId('conversation-rebuild-dry-run')).toBeEnabled();
  await page.getByTestId('conversation-rebuild-start').click();

  await expect.poll(() => calls.start.length).toBe(1);
  expect(calls.start[0]).toEqual({ dryRun: true });
  await expect(page.getByTestId('conversation-rebuild-result')).toBeVisible();
});

test('cancelling the confirmation performs no rebuild', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const calls = await stubRebuild(page);
  await openAppearance(page);

  await page.getByTestId('conversation-rebuild-open').click();
  await expect(page.getByTestId('conversation-rebuild-dialog')).toBeVisible();
  await page.getByTestId('conversation-rebuild-cancel').click();

  await expect(page.getByTestId('conversation-rebuild-dialog')).toBeHidden();
  expect(calls.start).toHaveLength(0);
  expect(calls.status).toBe(0);
});

test('turning the dry run off asks the API to regroup for real', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const calls = await stubRebuild(page, { result: { scanned: 40, would_change: 0, changed: 7, dryRun: false } });
  await openAppearance(page);

  await page.getByTestId('conversation-rebuild-open').click();
  const dryRun = page.getByTestId('conversation-rebuild-dry-run');
  await dryRun.uncheck();
  await expect(dryRun).not.toBeChecked();
  await page.getByTestId('conversation-rebuild-start').click();

  await expect.poll(() => calls.start.length).toBe(1);
  expect(calls.start[0]).toEqual({ dryRun: false });
});

test('the result tells the user what the rebuild did', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const calls = await stubRebuild(page, { result: { scanned: 1234, would_change: 56, changed: 0, dryRun: true } });
  await openAppearance(page);
  await page.getByTestId('conversation-rebuild-open').click();
  await page.getByTestId('conversation-rebuild-start').click();

  const summary = page.getByTestId('conversation-rebuild-result');
  await expect(summary).toBeVisible();
  // Both counts have to be readable whatever the locale's digit grouping is, so
  // compare the digits with any separator between them.
  await expect(summary).toContainText(/1\D?234/);
  await expect(summary).toContainText(/\b56\b/);
  await expect.poll(() => calls.status).toBeGreaterThan(0);
});

test('a rate-limited rebuild explains itself instead of looking broken', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/mail/conversations/rebuild', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ status: 429, json: { error: 'Conversation rebuild rate limit exceeded' } });
  });
  await openAppearance(page);

  await page.getByTestId('conversation-rebuild-open').click();
  await page.getByTestId('conversation-rebuild-start').click();

  const alert = page.getByTestId('conversation-rebuild-error');
  await expect(alert).toBeVisible();
  // The translated message, not the raw server string.
  await expect(alert).not.toContainText('rate limit exceeded');
});
