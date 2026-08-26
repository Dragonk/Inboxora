import { test as base, expect } from '@playwright/test';

const fixture = {
  user: { id: 'e2e-user', username: 'e2e@example.test', isAdmin: true },
  accounts: [
    { id: 'account-gmail', name: 'Gmail fixture', email_address: 'me@gmail.test', color: '#4285f4' },
    { id: 'account-outlook', name: 'Outlook fixture', email_address: 'me@outlook.test', color: '#0078d4' },
    { id: 'account-fastmail', name: 'Fastmail fixture', email_address: 'me@fastmail.test', color: '#4b6bfb' },
  ],
  conversations: [
    {
      conversation_id: 'conversation-gmail',
      canonical_subject: 'Gmail reply chain',
      logical_message_count: 5,
      visible_copy_count: 6,
      latest_message_is_mine: false,
      latestCopyId: 'conversation-gmail-copy-5',
    },
    {
      conversation_id: 'conversation-outlook',
      canonical_subject: 'Outlook conversation',
      logical_message_count: 2,
      visible_copy_count: 2,
      latest_message_is_mine: false,
      latestCopyId: 'conversation-outlook-copy-2',
    },
    {
      conversation_id: 'conversation-fastmail',
      canonical_subject: 'Fastmail generic IMAP',
      logical_message_count: 2,
      visible_copy_count: 2,
      latest_message_is_mine: true,
    },
  ],
};

for (const row of fixture.conversations) {
  row.account_id = conversationAccountId(row.conversation_id);
  row.latest_copy_id = row.latestCopyId || `${row.conversation_id}-copy-${row.logical_message_count}`;
  row.copy_count = row.visible_copy_count;
  row.unread_count = 0;
  row.is_starred = false;
  row.logical_messages = Array.from({ length: row.logical_message_count }, (_, index) => ({
    id: `${row.conversation_id}-logical-${index + 1}`,
    subject: row.canonical_subject,
    direction: 'outgoing', // deliberately ignored by the reader; physical account identity is authoritative
    snippet: `Fixture body ${index + 1}`,
    fromName: 'Fixture Sender',
    fromEmail: row.conversation_id === 'conversation-gmail' && [1, 3].includes(index) ? 'me@gmail.test' : 'sender@gmail.test',
    messageDate: new Date(2026, 0, index + 1).toISOString(),
    folder: row.conversation_id === 'conversation-gmail' ? ['INBOX', 'Sent', 'Archive', 'Sent', 'INBOX'][index] : 'INBOX',
    isLatest: index === row.logical_message_count - 1,
    latestCopyId: `${row.conversation_id}-copy-${index + 1}`,
  }));
  const latest = row.logical_messages.at(-1);
  row.subject = row.canonical_subject;
  row.from_name = latest.fromName;
  row.from_email = latest.fromEmail;
  row.snippet = latest.snippet;
  row.date = latest.messageDate;
  row.folder = latest.folder;
}

function conversationAccountId(id) {
  if (id === 'conversation-outlook') return 'account-outlook';
  if (id === 'conversation-fastmail') return 'account-fastmail';
  return 'account-gmail';
}

function accountAddress(accountId) {
  return fixture.accounts.find(account => account.id === accountId)?.email_address;
}

function details(id) {
  const row = fixture.conversations.find(item => item.conversation_id === id) || fixture.conversations[0];
  const accountId = conversationAccountId(row.conversation_id);
  const ownAddress = accountAddress(accountId);
  const provider = accountId.replace('account-', '');
  return {
    summary: { ...row, conversation_id: row.conversation_id, canonical_subject: row.canonical_subject, account_id: accountId },
    logicalMessages: Array.from({ length: row.logical_message_count }, (_, index) => {
      const number = index + 1;
      const goldenGmailDirection = ['incoming', 'outgoing', 'incoming', 'outgoing', 'incoming'];
      const outgoing = row.conversation_id === 'conversation-gmail'
        ? goldenGmailDirection[index] === 'outgoing'
        : index === row.logical_message_count - 1 && row.latest_message_is_mine;
      const folder = row.conversation_id === 'conversation-gmail'
        ? ['INBOX', 'Sent', 'Archive', 'Sent', 'INBOX'][index]
        : outgoing ? 'Sent' : 'INBOX';
      const copy = {
        id: `${row.conversation_id}-copy-${number}`,
        accountId,
        messageId: `<${row.conversation_id}-${number}-${provider}@fixture.test>`,
        subject: row.canonical_subject,
        fromEmail: outgoing ? ownAddress : `sender@${provider}.test`,
        to: outgoing ? [{ email: `recipient@${provider}.test` }] : [{ email: ownAddress }],
        snippet: `Fixture summary ${row.conversation_id} ${number}`,
        bodyText: `${provider} fixture body ${number}`,
        bodyHtml: `<p>${provider} fixture body ${number}</p>`,
        isRead: true,
        isStarred: false,
        folder,
        listUnsubscribe: number === 1 ? 'https://unsubscribe.example.test' : null,
        attachments: number === 1 ? [{ part: 'fixture-part', filename: `${provider}-fixture.txt` }] : [],
      };
      const copies = [copy];
      if (row.conversation_id === 'conversation-gmail' && number === 4) {
        copies.push({
          ...copy,
          id: 'conversation-gmail-copy-4-all-mail',
          folder: 'All Mail',
        });
      }
      return {
        id: `${row.conversation_id}-logical-${number}`,
        subject: row.canonical_subject,
        direction: outgoing ? 'incoming' : 'outgoing', // stale logical direction must be ignored
        copies,
      };
    }),
  };
}


export const test = base.extend({
  fixtureApi: async ({ page }, use) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { user: fixture.user } }));
    await page.route('**/api/auth/preferences**', async route => {
      if (route.request().method() === 'PATCH') return route.fulfill({ json: { ok: true } });
      const matrix = page.__conversationMatrix || '11';
      const listEnabled = matrix[0] !== '0';
      const readerEnabled = matrix[1] !== '0';
      return route.fulfill({ json: {
        language: 'pl',
        theme: 'light',
        threadedView: listEnabled,
        conversation_list_view_enabled: listEnabled,
        conversation_reader_view_enabled: readerEnabled,
        block_remote_images: true,
      } });
    });
    // Keep optional boot calls from reaching the real backend. A 401 from one of
    // these non-auth endpoints dispatches session_expired in api.js and would log
    // the mocked user out before ConversationList/Pane finish mounting.
    await page.route('**/api/accounts', route => route.fulfill({ json: fixture.accounts }));
    await page.route('**/api/ai/status', route => route.fulfill({ json: { enabled: false } }));
    await page.route('**/api/todoist/status', route => route.fulfill({ json: { connected: false } }));
    await page.route('**/api/update', route => route.fulfill({ json: { current: '3.2.4', latest: '3.2.4', updateAvailable: false } }));
    await page.route('**/api/contacts**', route => route.fulfill({ json: { contacts: [], total: 0 } }));
    await page.route('**/api/auth/registration-status', route => route.fulfill({ json: { open: true, internalAuthDisabled: false } }));
    await page.route('**/api/auth/oidc/providers', route => route.fulfill({ json: { providers: [] } }));
    await page.route('**/api/mail/unread-counts', route => route.fulfill({ json: { total: 0, byAccount: {} } }));
    page.__conversationActions = [];
    await page.route(url => /\/api\/mail\/conversations\/[^/]+\/(archive|move|delete|read|star)$/.test(url.pathname), async route => {
      const request = route.request();
      page.__conversationActions.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/accounts/*/folders', route => route.fulfill({ json: [
      { path: 'Archive', name: 'Archive', special_use: '\\Archive' },
      { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
    ] }));
    // Register broad handlers first; Playwright evaluates routes newest-first, so
    // the specific identity/body handlers below must be registered afterwards.
    await page.route('**/api/mail/conversations**', route => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts.at(-1);
      if (parts.includes('logical-messages') || ['archive', 'move', 'delete', 'read', 'star'].includes(id)) return route.fallback();
      if (id && id !== 'conversations') return route.fulfill({ json: details(id) });
      return route.fulfill({ json: { conversations: fixture.conversations, nextCursor: null, total: fixture.conversations.length } });
    });
    await page.route('**/api/mail/messages/*', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: { id: url.pathname.split('/').at(-1), subject: 'Legacy fixture', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@example.test', body_text: 'Fixture body legacy' } });
    });
    await page.route(url => /\/api\/mail\/conversations\/[^/]+\/logical-messages\/[^/]+\/body(?:\?.*)?$/.test(url.pathname + url.search), route => {
      const url = new URL(route.request().url());
      const copyId = url.searchParams.get('copyId');
      return route.fulfill({ json: { physical_copy_id: copyId, attachments: [{ part: 'fixture-part', filename: 'gmail-fixture.txt' }], body_text: `Fixture body lazy ${copyId}`, body_html: `<p>Fixture body lazy ${copyId}</p><img src="https://tracker.example.test/pixel.gif"><a href="https://example.test">Safe link</a>` } });
    });
    await page.route('**/api/mail/messages/*/conversation**', route => {
      const url = new URL(route.request().url());
      const copyId = url.pathname.split('/').at(-2);
      const match = copyId.match(/copy-(\d+)$/);
      const logicalIndex = match ? Math.min(Number(match[1]), 5) : 1;
      return route.fulfill({ json: { id: copyId, account_id: page.__unknownConversationAccount ? 'account-unknown' : 'account-gmail', conversation_id: 'conversation-gmail', logical_message_id: page.__invalidConversationTarget ? 'stale-logical-message' : `conversation-gmail-logical-${logicalIndex}` } });
    });
    await page.route('**/api/mail/messages*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/conversation')) {
        const copyId = url.pathname.split('/').at(-2);
        const match = copyId.match(/copy-(\d+)$/);
        const logicalIndex = match ? Math.min(Number(match[1]), 5) : 1;
        return route.fulfill({ json: { id: copyId, account_id: page.__unknownConversationAccount ? 'account-unknown' : 'account-gmail', conversation_id: 'conversation-gmail', logical_message_id: page.__invalidConversationTarget ? 'stale-logical-message' : `conversation-gmail-logical-${logicalIndex}` } });
      }
      if (/\/api\/mail\/messages\/[^/]+$/.test(url.pathname)) return route.fulfill({ json: { id: 'legacy-message-1', subject: 'Legacy fixture', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@example.test', body_text: 'Fixture body legacy' } });
      const messages = [
        { id: 'conversation-gmail-copy-1', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-1>', body_text: 'Fixture body 1', thread_id: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-2', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-2>', body_text: 'Fixture body 2', thread_id: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-3', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Archive', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-3>', body_text: 'Fixture body 3', thread_id: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-4', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-4>', body_text: 'Fixture body 4', thread_id: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-5', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-5>', body_text: 'Fixture body 5', thread_id: 'conversation-gmail', message_count: 5 },
      ];
      if (url.pathname.includes('/api/mail/thread/')) return route.fulfill({ json: { messages } });
      return route.fulfill({ json: { messages, total: messages.length } });
    });
    await page.route('**/api/mail/thread/*', route => route.fulfill({ json: { messages: [
      { id: 'conversation-gmail-copy-1', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-1>', body_text: 'Fixture body 1', thread_id: 'conversation-gmail' },
      { id: 'conversation-gmail-copy-2', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-2>', body_text: 'Fixture body 2', thread_id: 'conversation-gmail' },
      { id: 'conversation-gmail-copy-3', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Archive', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-3>', body_text: 'Fixture body 3', thread_id: 'conversation-gmail' },
      { id: 'conversation-gmail-copy-4', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-4>', body_text: 'Fixture body 4', thread_id: 'conversation-gmail' },
      { id: 'conversation-gmail-copy-5', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-5>', body_text: 'Fixture body 5', thread_id: 'conversation-gmail' },
    ] } }));
    await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { body_text: 'Fixture body legacy', body_html: '<p>Fixture body legacy</p>' } }));
    await page.route('**/api/mail/conversations/*/overrides', route => route.fulfill({ json: { ok: true, overrides: [] } }));
    await use(fixture);
  },
});

export { expect, fixture };
