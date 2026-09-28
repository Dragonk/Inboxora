import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

// Queue behavior is tested against mocked HTTP; native PWA services have their
// own full-Chromium real-app coverage and must not intercept these fixtures.
test.use({ serviceWorkers: 'block' });

type Summary = { id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: string;
  scheduledAt: string; timeZone: string; revision: number; errorCode: string | null };
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
  await page.route('**/api/mail/scheduled', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 503, json: { error: 'Unexpected enqueue in browser test' } });
    await options.scheduledRead?.();
    return route.fulfill({ json: rows });
  });
  await page.route('**/api/mail/send', route => route.fulfill({ status: 503, json: { error: 'Immediate sending blocked in browser test' } }));
  await page.route('**/api/mail/send-limits**', route => route.fulfill({ json: { transport: 'imap_smtp', limits: {} } }));
  await page.route('**/api/search/contacts**', route => route.fulfill({ json: [] }));
  await page.route('**/api/mail/draft', route => route.fulfill({ json: { uid: 44, folder: 'Drafts', uidValidity: 1 } }));
  await page.goto('/');
  if (options.waitForMailList !== false) await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}
async function compose(page: Page) {
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
  await page.getByTestId('compose-to').fill('recipient@example.test');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Queued fixture');
  await page.locator('.tiptap-compose [contenteditable="true"]').fill('Queued body');
}
async function outbox(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-scheduled').click();
  await expect(page.getByTestId('scheduled-view')).toBeVisible();
}
async function selectSchedule(page: Page, date = '2030-01-15', time = '13:45', zone = 'Europe/Warsaw') {
  await page.getByTestId('schedule-date-time').fill(`${date}T${time}`);
  await page.getByTestId('schedule-zone').fill(zone);
}

test('Undo queues instead of sending, survives reload and restores the paused full message', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const rows: Summary[] = []; let immediate = 0; let enqueue: Record<string, unknown> | undefined;
  await boot(page, rows, { undo: 60 });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/mail/scheduled', route => {
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
    await page.route('**/api/mail/scheduled', route => {
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
  await page.route('**/api/mail/scheduled', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    queued++; return route.fulfill({ json: pending() });
  });
  await expect(page.getByTestId('compose-send')).toBeDisabled();
  await expect(page.getByTestId('compose-schedule')).toBeDisabled();
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
  await page.route('**/api/mail/scheduled', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    payload = route.request().postDataJSON(); return route.fulfill({ json: pending({ mode: 'schedule' }) });
  });
  await page.getByTestId('compose-schedule').click();
  await selectSchedule(page, '2030-03-31', '02:30');
  await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
  await selectSchedule(page, '2030-10-27', '02:30');
  await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
  await selectSchedule(page);
  await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
  await expect(page.getByText(/(?:GMT|UTC)\+01:00/)).toBeVisible();
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => payload).toMatchObject({ mode: 'schedule', scheduledAt: '2030-01-15T12:45:00.000Z', timeZone: 'Europe/Warsaw' });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

for (const mode of ['undo', 'schedule'] as const) {
  test(`${mode}: lost acknowledgement retries the same frozen request and idempotency key`, async ({ page, fixtureApi }) => {
    await fixtureApi; await boot(page, [], { undo: 60 }); await compose(page);
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route('**/api/mail/scheduled', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: [] });
      writes.push({ body: route.request().postDataJSON(), key: route.request().headers()['x-idempotency-key'] });
      return writes.length === 1 ? route.abort('connectionfailed') : route.fulfill({ json: pending({ mode }) });
    });
    if (mode === 'schedule') {
      await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
      await page.getByTestId('schedule-confirm').click();
    } else await page.getByTestId('compose-send').click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByTestId('compose-send')).toBeEnabled();
    await expect(page.getByTestId('compose-to')).toBeDisabled();
    await expect(page.getByTestId('compose-schedule')).toBeDisabled();
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
    saved = route.request().postDataJSON(); return route.fulfill({ json: { ...rows[0], state: 'pending', revision: 2 } });
  });
  await page.route('**/api/mail/scheduled', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    created++; return route.fulfill({ status: 503, json: {} });
  });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503, json: {} }); });
  await page.getByTestId('scheduled-edit-queued-1').click();
  await expect(page.getByText('frozen.txt', { exact: true })).toBeVisible();
  await page.getByTestId('compose-from').selectOption('account:account-gmail');
  await page.getByTestId('compose-from').selectOption('alias:work:account-gmail');
  await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
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
    await page.route('**/api/mail/scheduled', route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
    await page.getByTestId('scheduled-view').getByRole('button', { name: 'Refresh', exact: true }).click();
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
    const body: Record<string, unknown> = route.request().postDataJSON(); writes.push(body);
    rows[0].revision++; rows[0].state = body.keepEditing === true ? 'editing' : 'pending';
    return route.fulfill({ json: rows[0] });
  });
  await page.route('**/api/mail/draft', route => { drafts++; return route.fulfill({ json: { uid: 44, folder: 'Drafts' } }); });
  await page.route('**/api/mail/send', route => { immediate++; return route.fulfill({ status: 503, json: {} }); });
  await page.route('**/api/mail/scheduled', route => {
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
  expect(writes[1]).toMatchObject({ revision: 2, sendNow: true, timeZone: 'UTC', message: { ...message, subject: 'Saved while paused' } });
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
  await page.route('**/api/mail/scheduled', route => {
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
    await outbox(page);
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
  await page.route('**/api/mail/scheduled', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    queued = route.request().postDataJSON(); return route.fulfill({ json: pending({ mode: 'schedule' }) });
  });
  try {
    await page.getByTestId('compose-schedule').click(); await selectSchedule(page);
    await page.clock.fastForward(30_000);
    await expect.poll(() => saving).toBe(true);
    await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
    await expect(page.getByTestId('schedule-date-time')).toBeVisible();
    expect(queued).toBeUndefined();
  } finally { release(); }
  await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
  await expect(page.getByTestId('schedule-date-time')).toHaveValue('2030-01-15T13:45');
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => queued).toMatchObject({ mode: 'schedule', scheduledAt: '2030-01-15T12:45:00.000Z', timeZone: 'Europe/Warsaw' });
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
});

test('an open formatting popup is removed while sending and stays unavailable after a lost acknowledgement', async ({ page, fixtureApi }) => {
  await fixtureApi; await boot(page, [], { undo: 60 }); await compose(page);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let sending = false;
  await page.route('**/api/mail/scheduled', async route => {
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
