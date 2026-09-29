import type { Page, Route } from '@playwright/test';
import { expect } from '@playwright/test';
import type { ScheduledMessage, ScheduledPreview, ScheduledSummary } from '../src/utils/scheduledMail.ts';

export const QUEUE_ACCOUNT = 'a1000000-0000-4000-8000-000000000001';
export const queueMessage: ScheduledMessage = {
  accountId: QUEUE_ACCOUNT, aliasId: 'work', to: ['Taylor Reed <taylor@example.test>'], cc: [], bcc: [],
  subject: 'Project Atlas — next steps', body: '<p>Hi Taylor,</p><p>The project plan is ready for your review. I have attached the updated milestones.</p><p>Let’s discuss the remaining questions tomorrow.</p>',
  bodyIsHtml: true, editedSignature: '<p>Alex Morgan<br>Product team</p>', editedSignatureIsHtml: true,
  sendKind: 'reply', replyToMessageId: 'b1000000-0000-4000-8000-000000000001',
  replyParentAccountId: QUEUE_ACCOUNT, replyParentMessageId: '<atlas-parent@example.test>',
  inReplyTo: '<atlas-parent@example.test>', references: '<atlas-root@example.test> <atlas-parent@example.test>',
  quotedBodyHtml: '<blockquote><p>Could you share the revised milestones?</p></blockquote>',
  attachments: [{ filename: 'milestones.txt', content: 'U2FmZSBmaXh0dXJl', contentType: 'text/plain' }],
};
export const queueRow = (id = 'overnight', overrides: Partial<ScheduledSummary> = {}): ScheduledSummary => ({
  id, accountId: QUEUE_ACCOUNT, subject: queueMessage.subject, state: 'sent', mode: 'schedule',
  scheduledAt: '2020-01-15T02:00:00.000Z', timeZone: 'Europe/Warsaw', revision: 1, errorCode: null,
  senderEmail: 'alex@example.test', to: queueMessage.to, cc: [], recipientCount: 1, ...overrides,
});
export function queueServer(rows: ScheduledSummary[]) {
  return { rows, seen: new Set<string>(), seenCalls: [] as string[], mutations: [] as Array<{ id: string; action: string; body: Record<string, unknown> }>,
    previews: [] as string[], previewOverrides: new Map<string, Partial<ScheduledPreview>>(),
    owners: new Map(rows.map(row => [row.id, 'queue-owner'])), expired: new Set<string>(),
    failSeen: false, failList: false, seenGate: undefined as Promise<void> | undefined, seenCompleted: 0,
    listReads: 0, bodyReads: [] as string[], sendCalls: 0 };
}
export type QueueServer = ReturnType<typeof queueServer>;
/** Every HTTP/WS request is controlled locally; these browser tests cannot dispatch mail. */
export async function bootQueue(page: Page, server: QueueServer, options: { theme?: 'light' | 'dark'; owner?: string } = {}) {
  const owner = options.owner ?? 'queue-owner';
  const theme = options.theme ?? 'light';
  await page.routeWebSocket('**/ws', socket => {
    socket.onMessage(data => { if (data === '{"type":"ping"}') socket.send('{"type":"pong"}'); });
  });
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value });
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const method = request.method();
    if (path === '/api/auth/me') return json(route, { user: { id: owner, username: 'alex@example.test', displayName: 'Alex Morgan', isAdmin: true } });
    if (path === '/api/auth/preferences') return json(route, { language: 'en', theme: theme === 'dark' ? 'dark_ink' : 'ink',
      themeMode: theme, themeLight: 'ink', themeDark: 'dark_ink', threadedView: false, undoSendSeconds: 30,
      conversation_list_view_enabled: false, conversation_reader_view_enabled: false, block_remote_images: true });
    if (path === '/api/accounts') return json(route, [
      { id: QUEUE_ACCOUNT, name: 'Work', email_address: 'alex@example.test', enabled: true, color: '#4f6ad8',
        signature: '<p>Alex Morgan<br>Product team</p>', aliases: [{ id: 'work', name: 'Alex Morgan', email: 'alex@example.test' }],
        folder_mappings: { drafts: 'Drafts', sent: 'Sent' }, default_cc: [], default_bcc: [] },
      { id: 'a2000000-0000-4000-8000-000000000002', name: 'Personal', email_address: 'alex@personal.test', enabled: true,
        color: '#27a77b', aliases: [], default_cc: [], default_bcc: [] },
    ]);
    if (/\/accounts\/[^/]+\/folders$/.test(path)) return json(route, [
      { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' }, { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
      { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
    ]);
    if (path === '/api/mail/scheduled') {
      if (server.expired.has(owner)) return json(route, { error: 'Session expired' }, 401);
      if (method !== 'GET') { server.sendCalls++; return json(route, { error: 'Unexpected enqueue' }, 503); }
      server.listReads++;
      if (server.failList) return json(route, { error: 'Queue unavailable' }, 503);
      const owned = server.rows.filter(row => server.owners.get(row.id) === owner);
      const visible = owned.filter(row => row.state !== 'cancelled' && !(row.state === 'sent' && server.seen.has(`${owner}:${row.id}`)));
      if (url.searchParams.get('page') !== '1') return json(route, visible.slice(0, 200));
      const cursor = url.searchParams.get('cursor');
      const remaining = cursor ? visible.filter(row => owned.indexOf(row) > owned.findIndex(item => item.id === cursor)) : visible;
      const items = remaining.slice(0, 200);
      return json(route, { items, nextCursor: remaining.length > 200 ? items.at(-1)?.id : null });
    }
    const queued = path.match(/^\/api\/mail\/scheduled\/([^/]+)(?:\/(seen|edit|cancel|dismiss))?$/);
    if (queued) {
      const id = decodeURIComponent(queued[1]); const action = queued[2]; const row = server.rows.find(item => item.id === id);
      if (!row || server.owners.get(id) !== owner) return json(route, { error: 'Missing queue item' }, 404);
      if (method === 'GET' && !action) {
        server.previews.push(id);
        return json(route, { id, state: row.state, senderEmail: row.senderEmail, context: [], contextMissing: false, sentCopy: null,
          message: ['sent', 'cancelled', 'dismissed'].includes(row.state) ? null : { ...queueMessage, subject: row.subject,
            attachments: queueMessage.attachments?.map(attachment => ({ filename: attachment.filename, contentType: attachment.contentType, size: 12 })) },
          ...server.previewOverrides.get(id) });
      }
      if (method === 'POST' && action === 'seen') {
        server.seenCalls.push(`${owner}:${id}`); await server.seenGate;
        server.seenCompleted++;
        if (server.failSeen) return json(route, { error: 'Receipt temporarily unavailable' }, 503);
        if (row.state !== 'sent') return json(route, { error: 'Not sent' }, 404);
        server.seen.add(`${owner}:${id}`); return json(route, { id });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      server.mutations.push({ id, action: action ?? method, body });
      if (body.revision !== row.revision) return json(route, { error: 'Changed revision' }, 409);
      if (action === 'edit') { row.state = 'editing'; return json(route, { ...row, message: queueMessage }); }
      if (method === 'PATCH') { row.scheduledAt = String(body.scheduledAt); row.timeZone = String(body.timeZone); row.revision++; row.state = 'pending'; }
      if (action === 'cancel') { row.state = 'cancelled'; row.revision++; }
      if (action === 'dismiss') { row.state = 'dismissed'; row.revision++; }
      return json(route, row);
    }
    if (path === '/api/mail/send' || path === '/api/mail/merge') { server.sendCalls++; return json(route, { error: 'Real delivery is prohibited in fixtures' }, 503); }
    if (path === '/api/mail/draft') return json(route, { uid: 22, folder: 'Drafts', uidValidity: 1 });
    if (path === '/api/mail/send-limits') return json(route, { transport: 'imap_smtp', limits: {} });
    if (path === '/api/mail/messages') return json(route, { messages: [], total: 0, hasMore: false });
    if (/\/api\/mail\/messages\/[^/]+\/body$/.test(path)) {
      server.bodyReads.push(path.split('/').at(-2)!);
      return json(route, { html: '<p>The real earlier message in the Atlas conversation.</p>', text: 'Earlier message', attachments: [] });
    }
    if (path === '/api/mail/unread-counts') return json(route, { total: 0, byAccount: {} });
    if (path === '/api/calendar/calendars') return json(route, { calendars: [] });
    if (path === '/api/calendar/events') return json(route, { events: [] });
    if (path.startsWith('/api/contacts')) return json(route, { contacts: [], total: 0 });
    if (path === '/api/search/contacts') return json(route, []);
    if (path === '/api/ai/status') return json(route, { enabled: false });
    if (path === '/api/todoist/status') return json(route, { connected: false });
    if (path === '/api/auth/registration-status') return json(route, { open: true, internalAuthDisabled: false });
    if (path === '/api/auth/oidc/providers') return json(route, { providers: [] });
    if (path === '/api/update') return json(route, { current: '4.1.2', latest: '4.1.2', updateAvailable: false });
    return json(route, {});
  });
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}
export async function enterQueue(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-scheduled').click();
  await expect(page.getByTestId('scheduled-view')).toBeVisible();
  await expect(page.getByTestId('scheduled-view')).toHaveAttribute('aria-busy', 'false');
}
export async function leaveQueue(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('all-inboxes').click();
  await expect(page.getByTestId('scheduled-view')).toHaveCount(0);
}
/** A controlled hidden-document lifecycle; scrolling/intersection/hit testing remain real browser behavior. */
export async function queueVisibility(page: Page, visibility: 'visible' | 'hidden') {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}
