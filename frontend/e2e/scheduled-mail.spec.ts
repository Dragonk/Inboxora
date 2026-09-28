import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

// Queue behavior is tested against mocked HTTP; native PWA services have their
// own full-Chromium real-app coverage and must not intercept these fixtures.
test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Warsaw' });

type Summary = { id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: string;
  scheduledAt: string; timeZone: string; revision: number; errorCode: string | null };
/** Build metadata-only queue fixtures without exposing delivery payloads. */
const pending = (overrides: Partial<Summary> = {}): Summary => ({ id: 'queued-1', accountId: 'account-gmail',
  subject: 'Queued fixture', mode: 'undo', state: 'pending', scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  timeZone: 'UTC', revision: 1, errorCode: null, ...overrides });
const message = { accountId: 'account-gmail', aliasId: 'work', to: ['rejected@example.test'], cc: [], bcc: [],
  subject: 'Queued fixture', body: '<p>Frozen queued body</p>', bodyIsHtml: true,
  editedSignature: '<p>Frozen signature</p>', editedSignatureIsHtml: true, priority: 'high',
  inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>',
  sendKind: 'reply', replyToMessageId: 'parent-id', replyParentMessageId: '<parent@example.test>',
  replyParentAccountId: 'account-gmail',
  attachments: [{ filename: 'frozen.txt', content: 'RnJvemVuIGJ5dGVzAA==', encoding: 'base64', contentType: 'text/plain' }] };

/** Boot an authenticated mailbox with all queue, draft and delivery traffic mocked. */
async function boot(page: Page, rows: Summary[] = [], options: { undo?: number; preferencesGate?: Promise<void>; preferencesError?: boolean; preferencesStarted?: () => void; waitForMailList?: boolean; defaultAlias?: string; scheduledRead?: () => Promise<void> } = {}) {
  // Keep realtime lifecycle isolated too; the preview server has no WebSocket backend.
  await page.routeWebSocket('**/ws', socket => {
    socket.onMessage(data => { if (data === '{"type":"ping"}') socket.send('{"type":"pong"}'); });
  });
  await page.route('**/api/accounts', route => route.fulfill({ json: [{ id: 'account-gmail', name: 'Fixture mailbox',
    email_address: 'me@gmail.test', signature: '<p>Frozen signature</p>', enabled: true, mail_transport: 'imap_smtp', folder_mappings: { drafts: 'Drafts' },
    default_alias_id: options.defaultAlias ?? null,
    aliases: [{ id: 'work', name: 'Work', email: 'work@example.test' }],
    default_cc: ['automatic@example.test'], default_bcc: ['private@example.test'],
  }] }));
  await page.route('**/api/auth/preferences**', async route => {
    options.preferencesStarted?.();
    await options.preferencesGate;
    if (options.preferencesError) return route.fulfill({ status: 503, json: { error: 'Preferences temporarily unavailable' } });
    return route.fulfill({ json: { language: 'en', threadedView: false, undoSendSeconds: options.undo ?? 0,
      conversation_list_view_enabled: false, conversation_reader_view_enabled: false } });
  });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 503, json: { error: 'Unexpected enqueue in browser test' } });
    await options.scheduledRead?.();
    return route.fulfill({ json: rows });
  });
  await page.route(/\/api\/mail\/scheduled\/[^/?]+$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = rows.find(item => item.id === id);
    if (!row) return route.fulfill({ status: 404, json: { error: 'Missing queue fixture' } });
    return route.fulfill({ json: { id, state: row.state, senderEmail: 'work@example.test', context: [], contextMissing: false,
      sentCopy: null, message: ['sent', 'cancelled', 'dismissed'].includes(row.state) ? null : { ...message,
        attachments: message.attachments.map(attachment => ({ filename: attachment.filename, contentType: attachment.contentType, size: 13 })) } } });
  });
  await page.route('**/api/mail/send', route => route.fulfill({ status: 503, json: { error: 'Immediate sending blocked in browser test' } }));
  await page.route('**/api/mail/send-limits**', route => route.fulfill({ json: { transport: 'imap_smtp', limits: {} } }));
  await page.route('**/api/search/contacts**', route => route.fulfill({ json: [] }));
  await page.route('**/api/mail/draft', route => route.fulfill({ json: { uid: 44, folder: 'Drafts', uidValidity: 1 } }));
  await page.goto('/');
  if (options.waitForMailList !== false) await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}
/** Open a populated composer through the public controls. */
async function compose(page: Page) {
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
  await page.getByTestId('compose-to').fill('recipient@example.test');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Queued fixture');
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Queued body');
}
/** Open the queue through the viewport-appropriate navigation. */
async function outbox(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-scheduled').click();
  await expect(page.getByTestId('scheduled-view')).toBeVisible();
  await expect(page.getByTestId('scheduled-view')).toHaveAttribute('aria-busy', 'false');
  const first = page.locator('[data-testid^="scheduled-item-"]').first();
  if (await first.count()) await first.getByRole('button').click();
}
/** Set the user's local fields; there is no editable server/IANA zone. */
async function selectSchedule(page: Page, date = '2030-01-15', time = '13:45') {
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Europe/Warsaw');
  await expect(page.getByTestId('schedule-zone')).toHaveCount(0);
  await page.getByTestId('schedule-date').fill(date);
  const [hour, minute] = time.split(':');
  await page.getByTestId('schedule-hour').selectOption(hour);
  await page.getByTestId('schedule-minute').selectOption(minute);
}

test('Undo queues instead of sending, survives reload and restores the paused full message', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const rows: Summary[] = []; let immediate = 0; let enqueue: Record<string, unknown> | undefined;
  await boot(page, rows, { undo: 60 });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ json: { ok: true } }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    enqueue = route.request().postDataJSON(); rows.push(pending()); return route.fulfill({ json: rows[0] });
  });
  await page.route('**/api/mail/scheduled/queued-1/edit', route => {
    expect(route.request().postDataJSON()).toEqual({ revision: 1 }); rows[0].state = 'editing';
    return route.fulfill({ json: { ...rows[0], message } });
  });
  await compose(page); await page.getByTestId('compose-send').click();
  await expect.poll(() => enqueue).toMatchObject({ mode: 'undo', message: { subject: 'Queued fixture', bodyIsHtml: true } });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  expect(immediate).toBe(0);
  await page.clock.install(); await page.clock.fastForward(10_000);
  await expect(page.getByTestId('scheduled-undo-queued-1')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('scheduled-undo-queued-1')).toBeVisible();
  await outbox(page);
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByTestId('compose-from')).toHaveValue('alias:work:account-gmail');
  await expect(page.getByText('frozen.txt', { exact: true })).toBeVisible();
  await expect(page.locator('.tiptap-compose [contenteditable="true"]')).toContainText('Frozen queued body');
  expect(immediate).toBe(0);
});

test('Send waits for server preferences during startup', async ({ page, fixtureApi }) => {
  await fixtureApi;
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let immediate = 0; let queued = 0; let preferencesStarted = false;
  try {
    await boot(page, [], { undo: 60, preferencesGate: gate, waitForMailList: false, preferencesStarted: () => { preferencesStarted = true; } });
    await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ json: { ok: true } }); });
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: [] });
      queued++; return route.fulfill({ json: pending() });
    });
    await expect.poll(() => preferencesStarted).toBe(true);
    await expect(page.getByTestId('message-list-scroll')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Compose', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('compose-send')).toHaveCount(0);
    expect(immediate).toBe(0); expect(queued).toBe(0);
  } finally { release(); }
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await compose(page);
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await page.getByTestId('compose-send').click();
  await expect.poll(() => queued).toBe(1); expect(immediate).toBe(0);
});

test('failed preferences keep sending disabled until a successful server retry', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const options = { undo: 60, preferencesError: true };
  await boot(page, [], options); await compose(page);
  let immediate = 0; let queued = 0;
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ json: { ok: true } }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    queued++; return route.fulfill({ json: pending() });
  });
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await expect(page.getByTestId('compose-send-menu')).toBeDisabled();
  await expect(page.getByTestId('compose-preferences-loading')).toContainText('Send preferences could not be loaded');
  expect(immediate).toBe(0); expect(queued).toBe(0);
  options.preferencesError = false;
  await page.getByTestId('compose-preferences-loading').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('compose-preferences-loading')).toHaveCount(0);
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await page.getByTestId('compose-send').click();
  await expect.poll(() => queued).toBe(1); expect(immediate).toBe(0);
});

test('schedule sends the exact selected instant and rejects DST gaps and repeated times', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page); await compose(page);
  let payload: Record<string, unknown> | undefined;
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    payload = route.request().postDataJSON(); return route.fulfill({ json: pending({ mode: 'schedule' }) });
  });
  await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click();
  await selectSchedule(page, '2030-03-31', '02:30');
  await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
  await selectSchedule(page, '2030-10-27', '02:30');
  await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
  await selectSchedule(page);
  await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
  await expect(page.getByText(/(?:GMT|UTC)\+1\b|CET/)).toBeVisible();
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => payload).toMatchObject({ mode: 'schedule', scheduledAt: '2030-01-15T12:45:00.000Z', timeZone: 'Europe/Warsaw' });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

for (const mode of ['undo', 'schedule'] as const) {
  test(`${mode}: lost acknowledgement retries the same frozen request and idempotency key`, async ({ page, fixtureApi }) => {
    await fixtureApi; await boot(page, [], { undo: 60 }); await compose(page);
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: [] });
      writes.push({ body: route.request().postDataJSON(), key: route.request().headers()['x-idempotency-key'] });
      return writes.length === 1 ? route.abort('connectionfailed') : route.fulfill({ json: pending({ mode }) });
    });
    if (mode === 'schedule') {
      await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
      await page.getByTestId('schedule-confirm').click();
    } else await page.getByTestId('compose-send').click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByTestId('compose-send')).toBeEnabled();
    await expect(page.getByTestId('compose-to')).toBeDisabled();
    await expect(page.getByTestId('compose-send-menu')).toBeDisabled();
    await page.getByTestId('compose-send').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[0].key).toBeTruthy(); expect(writes[1]).toEqual(writes[0]);
    if (mode === 'schedule') expect(writes[1].body).toMatchObject({ scheduledAt: '2030-01-15T12:45:00.000Z', timeZone: 'Europe/Warsaw' });
    await expect(page.getByTestId('compose-from')).toHaveCount(0);
  });
}

test('cancellation conflict refreshes current state and never reports a cancelled delivery', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ mode: 'schedule' })]; await boot(page, rows); await outbox(page);
  let cancellations = 0;
  await page.route('**/api/mail/scheduled/queued-1/cancel', route => {
    cancellations++; rows[0].state = 'sending';
    return route.fulfill({ status: 409, json: { error: 'The message is already being delivered', code: 'SCHEDULE_CONFLICT' } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.getByTestId('scheduled-cancel-queued-1').click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true });
  if (await confirm.count()) await confirm.click();
  await expect.poll(() => cancellations).toBe(1);
  await expect(page.getByTestId('scheduled-item-queued-1')).toContainText('Sending');
  await expect(page.getByTestId('scheduled-item-queued-1')).not.toContainText('Cancelled');
});

test('a partial queued edit reschedules its original record and preserves bytes, headers and rejected recipients', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'partial', mode: 'schedule' })]; await boot(page, rows); await outbox(page);
  await page.route('**/api/mail/scheduled/queued-1/edit', route => {
    rows[0].state = 'editing'; return route.fulfill({ json: { ...rows[0], message } });
  });
  let saved: Record<string, unknown> | undefined; let created = 0; let immediate = 0;
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    saved = route.request().postDataJSON(); return route.fulfill({ json: { ...rows[0], state: 'pending', revision: 2 } });
  });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    created++; return route.fulfill({ status: 503, json: {} });
  });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503, json: {} }); });
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByText('frozen.txt', { exact: true })).toBeVisible();
  await page.getByTestId('compose-from').selectOption('account:account-gmail');
  await page.getByTestId('compose-from').selectOption('alias:work:account-gmail');
  await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => saved).toMatchObject({ revision: 1, scheduledAt: '2030-01-15T12:45:00.000Z', message });
  expect(created).toBe(0); expect(immediate).toBe(0);
});

test('a late pause response after session expiration cannot reopen the queued editor', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ mode: 'schedule' })]; await boot(page, rows); await outbox(page);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false; let completed = false;
  await page.route('**/api/mail/scheduled/queued-1/edit', async route => {
    started = true; await gate;
    await route.fulfill({ json: { ...rows[0], state: 'editing', message } }); completed = true;
  });
  try {
    await page.getByTestId('scheduled-edit-queued-1').click();
    await expect.poll(() => started).toBe(true);
    // Expire through the real API client's 401 handler while the pause acknowledgement is held.
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
    await page.getByTestId('scheduled-refresh').click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(() => completed).toBe(true);
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-view')).toHaveCount(0);
});

test('paused autosave preserves the original record and Send now resumes its updated revision', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'editing', mode: 'schedule' })]; await boot(page, rows); await outbox(page);
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
  const writes: Record<string, unknown>[] = []; let drafts = 0; let immediate = 0; let enqueues = 0;
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const body: Record<string, unknown> = route.request().postDataJSON(); writes.push(body);
    rows[0].revision++; rows[0].state = body.keepEditing === true ? 'editing' : 'pending';
    return route.fulfill({ json: rows[0] });
  });
  await page.route('**/api/mail/draft', route => { drafts++; return route.fulfill({ json: { uid: 44, folder: 'Drafts' } }); });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503, json: {} }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    enqueues++; return route.fulfill({ status: 503, json: {} });
  });
  await page.clock.install();
  await page.getByTestId('scheduled-edit-queued-1').click();
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Saved while paused');
  await page.clock.fastForward(30_000);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ revision: 1, keepEditing: true, message: { ...message, subject: 'Saved while paused' } });
  expect(rows[0].state).toBe('editing'); expect(drafts).toBe(0);
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await page.getByTestId('compose-send').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ revision: 2, sendNow: true, timeZone: 'Europe/Warsaw', message: { ...message, subject: 'Saved while paused' } });
  expect(writes[1]).not.toHaveProperty('keepEditing');
  expect(drafts).toBe(0); expect(immediate).toBe(0); expect(enqueues).toBe(0);
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('default zero keeps the existing immediate send path', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page); await compose(page);
  let sent: Record<string, unknown> | undefined; let queued = 0;
  await page.route('**/api/mail/send', route => {
    sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    queued++; return route.fulfill({ status: 503, json: {} });
  });
  await page.getByTestId('compose-send').click();
  await expect.poll(() => sent).toMatchObject({ subject: 'Queued fixture', bodyIsHtml: true });
  await expect(page.getByTestId('compose-from')).toHaveCount(0); expect(queued).toBe(0);
});

test('editing a queued primary sender never reapplies the account default alias', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const rows = [pending({ mode: 'schedule' })];
  const primaryMessage: Record<string, unknown> = { ...message };
  delete primaryMessage.aliasId;
  await boot(page, rows, { defaultAlias: 'work' }); await outbox(page);
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], state: 'editing', message: primaryMessage } }));
  let resumed: Record<string, unknown> | undefined;
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    resumed = route.request().postDataJSON(); return route.fulfill({ json: { ...rows[0], revision: 2 } });
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByTestId('compose-from')).toHaveValue('account:account-gmail');
  await page.getByTestId('compose-send').click();
  await expect.poll(() => resumed).toMatchObject({ revision: 1, sendNow: true, message: primaryMessage });
  expect(resumed?.message).not.toHaveProperty('aliasId');
});

test('Undo during another unsaved compose pauses the original without replacing new content', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending()]; await boot(page, rows); await compose(page);
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Unrelated unsaved message');
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Keep this newer body');
  const preservedHtml = await page.locator('.tiptap-compose [contenteditable="true"]').innerHTML();
  let paused = 0; let sent: Record<string, unknown> | undefined;
  await page.route('**/api/mail/scheduled/queued-1/edit', route => {
    paused++; rows[0].state = 'editing'; return route.fulfill({ json: { ...rows[0], message } });
  });
  await page.route('**/api/mail/send', route => {
    sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } });
  });
  await expect(page.getByTestId('scheduled-undo-queued-1')).toBeVisible();
  await page.getByTestId('scheduled-undo-queued-1').click();
  await expect.poll(() => paused).toBe(1); expect(rows[0].state).toBe('editing');
  await expect(page.getByPlaceholder(/^(Add a subject|Subject)$/)).toHaveValue('Unrelated unsaved message');
  await expect(page.locator('.tiptap-compose [contenteditable="true"]')).toHaveText('Keep this newer body');
  await expect(page.getByTestId('compose-to').locator('..')).toContainText('recipient@example.test');
  await page.getByTestId('compose-send').click();
  await expect.poll(() => sent).toMatchObject({ subject: 'Unrelated unsaved message', body: preservedHtml, to: ['recipient@example.test'] });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  await outbox(page);
  await expect(page.getByTestId('scheduled-item-queued-1')).toContainText('Editing (paused)');
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByPlaceholder(/^(Add a subject|Subject)$/)).toHaveValue('Queued fixture');
  await expect(page.getByText('frozen.txt', { exact: true })).toBeVisible();
});

test('a queue read slower than the poll interval still restores pending Undo after reload', async ({ page, fixtureApi }) => {
  await fixtureApi;
  let releaseFirst: () => void = () => {}; const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseLater: () => void = () => {}; const later = new Promise<void>(resolve => { releaseLater = resolve; });
  let reads = 0;
  await page.clock.install();
  try {
    await boot(page, [pending()], { scheduledRead: () => { reads++; return reads === 1 ? first : later; } });
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(6_000);
    // Only the original response is released. A poll must not supersede it forever.
    releaseFirst();
    await expect(page.getByTestId('scheduled-undo-queued-1')).toBeVisible();
    if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('sidebar-scheduled').click();
    await expect(page.getByTestId('scheduled-view')).toHaveAttribute('aria-busy', 'true');
    await page.clock.fastForward(6_000);
    releaseLater();
    await expect(page.getByTestId('scheduled-view')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('scheduled-item-queued-1')).toContainText('Queued fixture');
  } finally { releaseFirst(); releaseLater(); }
});

test('schedule confirmation waits for an in-flight autosave without discarding the selected instant', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page); await page.clock.install(); await compose(page);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let saving = false; let queued: Record<string, unknown> | undefined;
  await page.route('**/api/mail/draft', async route => {
    saving = true; await gate; return route.fulfill({ json: { uid: 44, folder: 'Drafts', uidValidity: 1 } });
  });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    queued = route.request().postDataJSON(); return route.fulfill({ json: pending({ mode: 'schedule' }) });
  });
  try {
    await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
    await page.clock.fastForward(30_000);
    await expect.poll(() => saving).toBe(true);
    await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
    await expect(page.getByTestId('schedule-date')).toBeVisible();
    expect(queued).toBeUndefined();
  } finally { release(); }
  await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
  await expect(page.getByTestId('schedule-date')).toHaveValue('2030-01-15');
  await expect(page.getByTestId('schedule-hour')).toHaveValue('13');
  await expect(page.getByTestId('schedule-minute')).toHaveValue('45');
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => queued).toMatchObject({ mode: 'schedule', scheduledAt: '2030-01-15T12:45:00.000Z', timeZone: 'Europe/Warsaw' });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('an open formatting popup is removed while sending and stays unavailable after a lost acknowledgement', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [], { undo: 60 }); await compose(page);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let sending = false;
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    sending = true; await gate; return route.abort('connectionfailed');
  });
  const editor = page.locator('.tiptap-compose .tiptap');
  await page.getByTitle('Insert link', { exact: true }).click();
  await page.getByPlaceholder('https://...').fill('https://unsaved.example.test');
  await expect(page.getByPlaceholder('https://...')).toBeVisible();
  try {
    // Programmatic focus leaves the mouse-driven popup open until send locks the editor.
    await page.getByTestId('compose-send').focus();
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => sending).toBe(true);
    await expect(page.getByPlaceholder('https://...')).toHaveCount(0);
    await expect(page.getByTitle('Insert link', { exact: true })).toHaveCount(0);
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toHaveText('Queued body');
  } finally { release(); }
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await expect(page.getByTitle('Insert link', { exact: true })).toHaveCount(0);
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(editor).toHaveText('Queued body');
});

test('held queued autosave allows body and recipient edits, serializes writes and blocks Send', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'editing', mode: 'schedule' })];
  await boot(page, rows); await outbox(page); await page.clock.install();
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: Record<string, unknown>[] = []; let deliveries = 0;
  await page.route('**/api/mail/send', route => { deliveries++; return route.fulfill({ status: 503, json: {} }); });
  await page.route('**/api/mail/scheduled/queued-1', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    const body: Record<string, unknown> = route.request().postDataJSON(); writes.push(body);
    if (writes.length === 1) await gate;
    rows[0].revision++;
    return route.fulfill({ json: rows[0] });
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  const editor = page.locator('.tiptap-compose [contenteditable="true"]');
  await editor.fill('First autosave body');
  const initialHtml = await editor.innerHTML();
  let newerHtml: string;
  try {
    await page.clock.fastForward(30_000);
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByTestId('compose-send')).toBeDisabled();
    await expect(page.getByTestId('compose-send-menu')).toBeDisabled();
    await editor.fill('Newer body while saving');
    newerHtml = await editor.innerHTML();
    await page.getByTestId('compose-to').fill('newer@example.test');
    await page.getByTestId('compose-to').press('Enter');
    await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Newer subject while saving');
    await page.keyboard.press('Control+Enter');
    await page.clock.fastForward(30_000);
    expect(writes).toHaveLength(1); expect(deliveries).toBe(0);
    expect(writes[0]).toMatchObject({ revision: 1, keepEditing: true, message: { body: initialHtml, to: message.to } });
    await expect(editor).toHaveText('Newer body while saving');
    await expect(page.getByTestId('compose-to').locator('..')).toContainText('newer@example.test');
  } finally { release(); }
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await page.clock.fastForward(30_000);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ revision: 2, keepEditing: true, message: { body: newerHtml, subject: 'Newer subject while saving', to: [...message.to, 'newer@example.test'] } });
  expect(deliveries).toBe(0);
});

test('lost queued autosave acknowledgement stays editable and replays exact snapshot before newer revision', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'editing', mode: 'schedule' })];
  await boot(page, rows); await outbox(page); await page.clock.install();
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
  const writes: Record<string, unknown>[] = []; let deliveries = 0; let enqueues = 0;
  await page.route('**/api/mail/send', route => { deliveries++; return route.fulfill({ status: 503, json: {} }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    enqueues++; return route.fulfill({ status: 503, json: {} });
  });
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) { rows[0].revision = 2; return route.abort('connectionfailed'); }
    if (writes.length > 2) rows[0].revision++;
    return route.fulfill({ json: rows[0] });
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  const editor = page.locator('.tiptap-compose [contenteditable="true"]');
  await editor.fill('Acknowledgement lost body');
  const initialHtml = await editor.innerHTML();
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId('compose-autosave-retry')).toBeVisible();
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await editor.fill('Keep this newer local body');
  const newerHtml = await editor.innerHTML();
  await page.getByTestId('compose-to').fill('after-loss@example.test');
  await page.getByTestId('compose-to').press('Enter');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Newer unsaved subject');
  await page.keyboard.press('Control+Enter');
  expect(writes).toHaveLength(1); expect(deliveries).toBe(0); expect(enqueues).toBe(0);
  await page.getByTestId('compose-autosave-retry').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[1]).toMatchObject({ revision: 1, keepEditing: true, message: { body: initialHtml, subject: message.subject, to: message.to } });
  await expect(editor).toHaveText('Keep this newer local body');
  await expect(page.getByPlaceholder(/^(Add a subject|Subject)$/)).toHaveValue('Newer unsaved subject');
  await expect(page.getByTestId('compose-send')).toBeEnabled();
  await page.clock.fastForward(30_000);
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ revision: 2, keepEditing: true, message: { body: newerHtml, subject: 'Newer unsaved subject', to: [...message.to, 'after-loss@example.test'] } });
  expect(deliveries).toBe(0); expect(enqueues).toBe(0);
});

test('late queued autosave acknowledgement after logout cannot restore editing or schedule more writes', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'editing', mode: 'schedule' })];
  await boot(page, rows); await outbox(page); await page.clock.install();
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0; let completed = false;
  await page.route('**/api/mail/scheduled/queued-1', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes++; await gate; await route.fulfill({ json: { ...rows[0], revision: 2 } }); completed = true;
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Pending save before logout');
  try {
    await page.clock.fastForward(30_000); await expect.poll(() => writes).toBe(1);
    await page.locator('.tiptap-compose [contenteditable="true"]').fill('Local edit before logout');
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
    await page.clock.fastForward(6_000);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(() => completed).toBe(true);
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  await expect(page.locator('.tiptap-compose [contenteditable="true"]')).toHaveCount(0);
  expect(writes).toBe(1);
});

test('uncertain dismissal confirms without cancellation or resend and retains only terminal metadata', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'uncertain', mode: 'schedule' })];
  await boot(page, rows); await outbox(page);
  const writes: { url: string; body: unknown }[] = [];
  await page.route('**/api/mail/**', route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    if (!route.request().url().endsWith('/queued-1/dismiss')) return route.fulfill({ status: 503, json: {} });
    rows[0] = { ...rows[0], state: 'dismissed', revision: 2 };
    return route.fulfill({ json: rows[0] });
  });
  await expect(page.getByTestId('scheduled-edit-queued-1')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-reschedule-queued-1')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-cancel-queued-1')).toHaveCount(0);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toMatch(/already.*deliver/i);
    expect(dialog.message()).toMatch(/recall/i);
    expect(dialog.message()).toMatch(/retr/i);
    await dialog.dismiss();
  });
  await page.getByTestId('scheduled-dismiss-queued-1').click();
  expect(writes).toHaveLength(0);
  await expect(page.getByTestId('scheduled-dismiss-queued-1')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('scheduled-dismiss-queued-1').click();
  await expect(page.getByTestId('scheduled-item-queued-1')).toContainText('Dismissed');
  expect(writes).toEqual([{ url: '/api/mail/scheduled/queued-1/dismiss', body: { revision: 1 } }]);
  await expect(page.getByTestId('scheduled-item-queued-1')).toContainText('Queued fixture');
  await expect(page.getByTestId('scheduled-item-queued-1')).not.toContainText('Frozen queued body');
  // Return to the mobile list before selecting again: hidden rows are not interactive.
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('scheduled-back').click();
  const item = page.getByTestId('scheduled-item-queued-1').getByRole('button');
  await expect(item).toHaveCount(1); await item.click();
  // Selection is read-only; no delivery action may reappear for a dismissed result.
  for (const action of ['edit', 'reschedule', 'cancel', 'dismiss']) {
    await expect(page.getByTestId(`scheduled-${action}-queued-1`)).toHaveCount(0);
  }
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('late uncertain dismissal acknowledgement is fenced after session expiration and never resends', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'uncertain', mode: 'schedule' })];
  await boot(page, rows); await outbox(page);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = []; let completed = false;
  await page.route('**/api/mail/**', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(new URL(route.request().url()).pathname);
    if (!route.request().url().endsWith('/queued-1/dismiss')) return route.fulfill({ status: 503, json: {} });
    await gate; await route.fulfill({ json: { ...rows[0], state: 'dismissed', revision: 2 } }); completed = true;
  });
  try {
    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId('scheduled-dismiss-queued-1').click();
    await expect.poll(() => writes.length).toBe(1);
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
    await page.getByTestId('scheduled-refresh').click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(() => completed).toBe(true);
  await expect(page.getByTestId('scheduled-view')).toHaveCount(0);
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  expect(writes).toEqual(['/api/mail/scheduled/queued-1/dismiss']);
});

test('queued autosave conflict preserves local text and never rebases or sends another client revision', async ({ page, fixtureApi }) => {
  await fixtureApi; const rows = [pending({ state: 'editing', mode: 'schedule' })];
  await boot(page, rows); await outbox(page); await page.clock.install();
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(route.request().postDataJSON()); rows[0].revision = 7;
    return route.fulfill({ status: 409, json: { error: 'Another client changed this message', code: 'SCHEDULE_CHANGED' } });
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  const editor = page.locator('.tiptap-compose [contenteditable="true"]');
  // Let TipTap's deferred initial autofocus settle under the installed clock,
  // then replace content through the same selection/typing path as the user.
  await page.clock.runFor(1);
  await expect(editor).toHaveText('Frozen queued body');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Keep local conflicting text');
  await expect(editor).toHaveText('Keep local conflicting text');
  await page.clock.fastForward(30_000);
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await expect(page.getByText('This message changed or delivery has started. Refresh and check its state.', { exact: true })).toBeVisible();
  await expect(editor).toHaveText('Keep local conflicting text');
  await editor.fill('Keep further local edits after conflict');
  await page.clock.fastForward(30_000);
  await expect(editor).toHaveText('Keep further local edits after conflict');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ revision: 1, keepEditing: true });
});

test('split Send menu is accessible and stays in the viewport', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page); await compose(page);
  const trigger = page.getByTestId('compose-send-menu');
  const send = page.getByTestId('compose-send');
  await expect(trigger).toHaveAccessibleName('Send options');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(send).toBeVisible(); await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox(); const sendBox = await send.boundingBox();
  if (!triggerBox || !sendBox) throw new Error('Split Send geometry is unavailable');
  expect(Math.abs(triggerBox.x - (sendBox.x + sendBox.width))).toBeLessThanOrEqual(2);
  await trigger.focus(); await page.keyboard.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: 'Send options' });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(page.getByTestId('compose-schedule')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('compose-mail-merge')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  const menuBox = await menu.boundingBox(); const viewport = page.viewportSize();
  if (!menuBox || !viewport) throw new Error('Send menu geometry is unavailable');
  expect(menuBox.x).toBeGreaterThanOrEqual(0); expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
  if (viewport.width >= 768) expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(sendBox.y);
  await page.getByTestId('compose-schedule').click();
  await expect(page.getByTestId('schedule-date')).toBeVisible();
});

test('mail merge confirms separate private delivery and retries one frozen batch', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [], { undo: 15 }); await compose(page);
  const requests: { key?: string; body: unknown }[] = [];
  let ordinarySends = 0;
  await page.route('**/api/mail/send', route => { ordinarySends++; return route.fulfill({ status: 503 }); });
  await page.route('**/api/mail/merge', route => {
    requests.push({ key: route.request().headers()['x-idempotency-key'], body: route.request().postDataJSON() });
    return requests.length === 1 ? route.abort('connectionfailed')
      : route.fulfill({ json: { id: 'batch-1', count: 3, scheduledAt: new Date().toISOString(), items: [] } });
  });
  await page.getByTestId('compose-to').fill('A <a@example.test> B <b@example.test>');
  await page.getByTestId('compose-send-menu').click();
  await page.getByTestId('compose-mail-merge').click();
  await expect(page.getByText('Check the mail merge recipients before sending.')).toBeVisible();
  expect(requests).toHaveLength(0);
  // Blur commits a recipient chip; correcting the text input alone would leave
  // the malformed chip in the authored recipient list.
  await page.getByTitle('A <a@example.test> B <b@example.test>', { exact: true }).getByRole('button').click();
  await expect(page.getByTitle('A <a@example.test> B <b@example.test>', { exact: true })).toHaveCount(0);
  let nativeDialogs = 0;
  page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });
  await page.getByTestId('compose-send-menu').click();
  await page.getByTestId('compose-mail-merge').click();
  const confirmation = page.getByTestId('mail-merge-dialog');
  await expect(confirmation).toContainText('3');
  await expect(confirmation).toContainText('Each message will show only its recipient');
  await page.keyboard.press('Control+Enter');
  expect(requests).toHaveLength(0);
  await page.getByTestId('mail-merge-confirm').click();
  expect(nativeDialogs).toBe(0);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].body).toMatchObject({ message: {
    to: ['recipient@example.test'], cc: ['automatic@example.test'], bcc: ['private@example.test'],
    subject: 'Queued fixture', bodyIsHtml: true,
  } });
  await expect(page.getByTestId('compose-send')).toHaveText(/Retry same request/);
  await expect(page.getByTestId('compose-send-menu')).toBeDisabled();
  await page.getByTestId('compose-send').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(ordinarySends).toBe(0);
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('keyboard activity in merge warnings cannot send an ordinary message or change the selected schedule', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [], { undo: 15 }); await compose(page);
  let immediate = 0; let merges = 0; const schedules: Record<string, unknown>[] = [];
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503 }); });
  await page.route('**/api/mail/merge', route => { merges++; return route.fulfill({ json: { id: 'batch', count: 3, items: [] } }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    schedules.push(route.request().postDataJSON());
    return route.fulfill({ json: pending({ mode: 'schedule' }) });
  });
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('');
  await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-mail-merge').click();
  await page.getByTestId('mail-merge-confirm').click();
  await expect(page.getByText('Send without a subject?')).toBeVisible();
  await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter');
  expect(immediate).toBe(0); expect(merges).toBe(0); expect(schedules).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click();
  await selectSchedule(page); await page.keyboard.press('Control+Enter');
  expect(immediate).toBe(0); expect(merges).toBe(0); expect(schedules).toHaveLength(0);
  await page.getByTestId('schedule-confirm').click();
  await expect(page.getByText('Send without a subject?')).toBeVisible();
  await page.keyboard.press('Control+Enter');
  expect(immediate).toBe(0); expect(merges).toBe(0); expect(schedules).toHaveLength(0);
  await page.getByRole('button', { name: 'Send anyway' }).last().click();
  await expect.poll(() => schedules.length).toBe(1);
  expect(schedules[0]).toMatchObject({ mode: 'schedule', scheduledAt: '2030-01-15T12:45:00.000Z' });
  expect(immediate).toBe(0); expect(merges).toBe(0);
});

test('forgotten attachment warning keeps a confirmed merge through keyboard activity', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page); await compose(page);
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Please see attached');
  let immediate = 0; let scheduled = 0; let merge = 0;
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503 }); });
  await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    scheduled++; return route.fulfill({ status: 503 });
  });
  await page.route('**/api/mail/merge', route => {
    merge++; return route.fulfill({ json: { id: 'batch', count: 3, items: [] } });
  });
  await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-mail-merge').click();
  await page.getByTestId('mail-merge-confirm').click();
  await expect(page.getByText('Forgot an attachment?')).toBeVisible();
  await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter');
  expect(immediate).toBe(0); expect(scheduled).toBe(0); expect(merge).toBe(0);
  await page.getByRole('button', { name: 'Send anyway' }).last().click();
  await expect.poll(() => merge).toBe(1);
  expect(immediate).toBe(0); expect(scheduled).toBe(0);
});

test('Undo Send presets preserve a legacy delay until the user chooses one', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [], { undo: 35 });
  const saves: unknown[] = [];
  await page.route('**/api/auth/preferences**', route => {
    if (route.request().method() === 'PATCH') {
      const patch: Record<string, unknown> = route.request().postDataJSON();
      // Startup may seed unrelated AI preferences; only writes to this setting
      // are evidence that the saved delay changed.
      if (Object.hasOwn(patch, 'undoSendSeconds')) saves.push(patch);
      return route.fulfill({ json: patch });
    }
    return route.fulfill({ json: { language: 'en', undoSendSeconds: 35 } });
  });
  await page.reload();
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings', { exact: true }).first().click();
  await page.getByTestId('admin-tab-appearance').click();
  await page.getByRole('button', { name: 'Layout', exact: true }).first().click();
  const control = page.getByRole('group', { name: 'Undo Send' });
  await expect(control.getByRole('button')).toHaveCount(4);
  await expect(control.getByRole('button')).toHaveText(['0 s', '15 s', '30 s', '60 s']);
  await expect(control.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(page.getByText('Current delay: 35 s.')).toBeVisible();
  expect(saves).toHaveLength(0);
  await control.getByRole('button', { name: '15 s' }).click();
  await expect.poll(() => saves).toEqual([{ undoSendSeconds: 15 }]);
  await expect(control.getByRole('button', { name: '15 s' })).toHaveAttribute('aria-pressed', 'true');
});

test('a queued editor cannot be converted to mail merge, including by keyboard shortcut', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [pending({ state: 'pending' })], { undo: 60 }); await outbox(page);
  await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: {
    ...pending({ state: 'editing' }), message,
  } }));
  let mergeRequests = 0; let queuedUpdates = 0;
  await page.route('**/api/mail/merge', route => { mergeRequests++; return route.fulfill({ status: 503 }); });
  await page.route('**/api/mail/scheduled/queued-1', route => {
    if (route.request().method() === 'GET') return route.fallback();
    if (route.request().method() === 'PUT') queuedUpdates++;
    return route.fulfill({ json: pending({ state: 'pending', revision: 2 }) });
  });
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByTestId('compose-send-menu')).toBeEnabled();
  await page.getByTestId('compose-send-menu').click();
  await page.getByTestId('compose-mail-merge').click();
  await expect(page.getByText('Finish or cancel the existing queued message')).toBeVisible();
  expect(mergeRequests).toBe(0);
  await page.getByTestId('compose-to').focus();
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => queuedUpdates).toBe(1);
  expect(mergeRequests).toBe(0);
});

for (const outcome of ['success', 'conflict', 'lost response', 'logout'] as const) {
  test(`explicit queued Save after autosave replay: ${outcome}`, async ({ page, fixtureApi }) => {
    // The explicit Save button belongs to the desktop composer, including resized clients.
    await page.setViewportSize({ width: 1280, height: 900 });
    await fixtureApi;
    const rows = [pending({ state: 'editing', mode: 'schedule' })];
    await boot(page, rows); await outbox(page); await page.clock.install();
    await page.route('**/api/mail/scheduled/queued-1/edit', route => route.fulfill({ json: { ...rows[0], message } }));
    const writes: Record<string, unknown>[] = []; let deliveries = 0; let enqueues = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/mail/send', route => { deliveries++; return route.fulfill({ status: 503, json: {} }); });
    await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: rows });
      enqueues++; return route.fulfill({ status: 503, json: {} });
    });
    await page.route('**/api/mail/scheduled/queued-1', async route => {
    if (route.request().method() === 'GET') return route.fallback();
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) { rows[0].revision = 2; return route.abort('connectionfailed'); }
      if (writes.length === 2) {
        await gate;
        if (outcome === 'conflict') return route.fulfill({ status: 409, json: { code: 'SCHEDULE_CHANGED' } });
        if (outcome === 'lost response') return route.abort('connectionfailed');
      } else rows[0].revision++;
      return route.fulfill({ json: rows[0] });
    });
    await page.getByTestId('scheduled-edit-queued-1').click();
    const editor = page.locator('.tiptap-compose [contenteditable="true"]');
    await editor.fill('Original uncertain autosave');
    await page.clock.fastForward(30_000);
    await expect(page.getByTestId('compose-autosave-retry')).toBeVisible();
    await editor.fill('Newer content before explicit Save');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    let newestHtml: string;
    try {
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]).toEqual(writes[0]);
      // Reconciliation itself remains an autosave; the following explicit save
      // must obtain the latest rendered snapshot, not its older click closure.
      await editor.fill('Newest content while reconciling');
      newestHtml = await editor.innerHTML();
      await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Newest reconciled subject');
      await page.getByTestId('compose-to').fill('newest@example.test');
      await page.getByTestId('compose-to').press('Enter');
      if (outcome === 'logout') {
        await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
        await page.clock.fastForward(6_000);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      }
    } finally { release(); }
    if (outcome === 'success') {
      await expect.poll(() => writes.length).toBe(3);
      expect(writes[2]).toMatchObject({ revision: 2, keepEditing: true, message: {
        body: newestHtml, subject: 'Newest reconciled subject', to: [...message.to, 'newest@example.test'],
        attachments: message.attachments,
      } });
      await expect(page.getByTestId('compose-send')).toBeEnabled();
      await page.clock.fastForward(30_000);
      expect(writes).toHaveLength(3); // The explicit save acknowledged the latest baseline.
    } else if (outcome === 'logout') {
      await page.clock.fastForward(30_000);
      await expect(page.getByTestId('compose-from')).toHaveCount(0);
      expect(writes).toHaveLength(2);
    } else {
      await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
      await expect(editor).toHaveText('Newest content while reconciling');
      await expect(page.getByTestId('compose-send')).toBeDisabled();
      expect(writes).toHaveLength(2); // No replacement revision after a conflict or uncertain replay.
    }
    expect(deliveries).toBe(0); expect(enqueues).toBe(0);
  });
}
