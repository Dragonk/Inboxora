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

function details(id, incomplete = false, ceMode = null, unreadCopyIds = []) {
  const row = fixture.conversations.find(item => item.conversation_id === id) || fixture.conversations[0];
  const accountId = conversationAccountId(row.conversation_id);
  const ownAddress = accountAddress(accountId);
  const provider = accountId.replace('account-', '');
  return {
    summary: { ...row, conversation_id: row.conversation_id, canonical_subject: row.canonical_subject, account_id: accountId },
    // Diagnostic fixture: CE can be historically incomplete while the proven native
    // thread still has all physical members. Reader must retain native membership.
    logicalMessages: Array.from({ length: incomplete ? 1 : row.logical_message_count }, (_, index) => {
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
        isRead: !unreadCopyIds.includes(`${row.conversation_id}-copy-${number}`),
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
    }).filter((_, index) => ceMode !== 'missing-n2' || index !== 1).concat(ceMode === 'stale' ? [{
      id: 'conversation-gmail-logical-stale', subject: 'Re: Pd: PLAC Broniewskiego',
      copies: [{ id: 'stale-ce-copy', accountId, messageId: '<stale@fixture.test>', fromEmail: '', date: '2026-08-25T13:33:00.000Z' }],
    }] : ceMode === 'duplicate-n2' ? [{
      id: 'conversation-gmail-logical-2-duplicate', subject: 'stale duplicate',
      copies: [{ id: 'conversation-gmail-copy-2', accountId, messageId: '<fixture-2>', fromEmail: 'me@gmail.test' }],
    }] : []),
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
        theme: page.__themeOverride || 'light',
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
      if (id && id !== 'conversations') return route.fulfill({ json: details(id, Boolean(page.__ceIncomplete), page.__ceMode || null, page.__unreadCopies || []) });
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
        { id: 'conversation-gmail-copy-1', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-1>', body_text: 'Fixture body 1', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-2', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-2>', body_text: 'Fixture body 2', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-3', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Archive', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-3>', body_text: 'Fixture body 3', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-4', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'Sent', date: new Date().toISOString(), from_email: 'me@gmail.test', message_id: '<fixture-4>', body_text: 'Fixture body 4', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_count: 5 },
        { id: 'conversation-gmail-copy-5', subject: 'Gmail reply chain', is_read: true, account_id: 'account-gmail', folder: 'INBOX', date: new Date().toISOString(), from_email: 'sender@gmail.test', message_id: '<fixture-5>', body_text: 'Fixture body 5', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_count: 5 },
      ];
      const threaded = url.searchParams.get('threaded') === 'true';
      const listMessages = threaded ? [{ ...messages.at(-1), thread_key: 'conversation-gmail', is_starred: true }] : messages;
      return route.fulfill({ json: { messages: listMessages, total: listMessages.length, ...(threaded ? { threaded: true } : {}) } });
    });
    await page.route('**/api/mail/thread/*', route => {
      const unread = new Set(page.__unreadCopies || []);
      return route.fulfill({ json: { messages: Array.from({ length: 5 }, (_, index) => {
        const number = index + 1;
        return { id: `conversation-gmail-copy-${number}`, subject: 'Gmail reply chain', is_read: !unread.has(`conversation-gmail-copy-${number}`), account_id: 'account-gmail', folder: ['INBOX', 'Sent', 'Archive', 'Sent', 'INBOX'][index], date: new Date(2026, 0, number).toISOString(), from_email: [1, 3].includes(index) ? 'me@gmail.test' : 'sender@gmail.test', message_id: `<fixture-${number}>`, body_text: `Fixture body ${number}`, thread_id: 'conversation-gmail', thread_key: 'conversation-gmail' };
      }) } });
    });
    await page.route('**/api/mail/messages/bulk-read', async route => {
      page.__bulkReadActions = page.__bulkReadActions || [];
      page.__bulkReadActions.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/mail/messages/*/body**', async route => {
      const url = new URL(route.request().url());
      const copyId = url.pathname.split('/').at(-2);
      const remoteImages = url.searchParams.get('remoteImages') === '1';
      const delay = page.__bodyResponseDelays?.[copyId] || 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (page.__bodyFailures?.has(copyId)) return route.fulfill({ status: 503, json: { error: 'Fixture body failed' } });
      if (page.__newsletterCopy === copyId) {
        return route.fulfill({ json: {
          attachments: [], text: 'Medium newsletter fixture', hasBlockedRemoteImages: false, remoteImages: true,
          html: '<table data-testid="newsletter-table" width="720"><tr><td><img data-testid="newsletter-banner" width="720" height="180" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><h1>Medium weekly ideas</h1><p>Practical ideas for better work and life, written for your reading list.</p><ul><li>First useful article</li><li>Second useful article</li></ul><p data-testid="newsletter-final-words">Final words remain visible on mobile viewport.</p><a href="https://example.test/this-is-a-very-long-newsletter-link-without-any-natural-break-points-to-test-wrapping">https://example.test/this-is-a-very-long-newsletter-link-without-any-natural-break-points-to-test-wrapping</a></td></tr></table>',
        } });
      }
      if (page.__plainQuoteFoldingCopy === copyId) {
        const longHistory = Array.from({ length: 80 }, (_, index) => `<p data-testid="historical-line">Older historical line ${index + 1}</p>`).join('');
        return route.fulfill({ json: {
          attachments: [],
          text: 'Fixture structural quote folding',
          html: `<p data-testid="current-content">kolejna odpowiedź</p><div><p data-testid="plain-reply-marker">On 25.08.2026, 11:42:57, Kamil Maciąg wrote:</p><p>Odpowiedź na testowy e-mail</p><div><p>On 25.08.2026, 11:42:08, Kamil Maciąg wrote:</p><p>Testowy e-mail</p>${longHistory}</div></div>`,
          hasBlockedRemoteImages: false,
          remoteImages: true,
        } });
      }
      if (page.__quoteFoldingCopy === copyId) {
        const nestedForwardHtml = [
          '<p data-testid="current-content">Thanks for the update — here is the forwarded thread.</p>',
          '<div class="gmail_quote_container" data-testid="forward-envelope">',
          '<div class="gmail_attr">---------- Forwarded message ---------<br>From: sender@example.com &lt;sender@example.com&gt;<br>Date: Tue, 25 Aug 2026<br>Subject: Project update</div>',
          '<div data-testid="forwarded-body"><p data-testid="forwarded-content">Here is the first forwarded message content.</p>',
          '<blockquote class="gmail_quote" data-testid="nested-reply">',
          '<div class="gmail_attr">On Mon, 24 Aug 2026 Jan Kowalski &lt;jan@example.com&gt; wrote:</div>',
          '<p data-testid="old-reply">Older reply history inside the forwarded content.</p>',
          '</blockquote>',
          '</div>',
          '</div>',
        ].join('');
        return route.fulfill({ json: {
          attachments: [],
          text: 'Fixture quote folding',
          html: nestedForwardHtml,
          hasBlockedRemoteImages: false,
          remoteImages: true,
        } });
      }
      const remote = '<img data-testid="remote-signature" width="96" height="96" loading="lazy" decoding="async" data-mailflow-remote-src="https://example.test/signature.png" data-mailflow-remote-blocked="true" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2296%22%20height%3D%2296%22%3E%3C%2Fsvg%3E">';
      return route.fulfill({ json: {
        attachments: [{ part: 'fixture-part', filename: 'gmail-fixture.txt' }],
        text: `Fixture body lazy ${copyId}`,
        html: `<p>Fixture body lazy ${copyId}</p>${remote}<img data-testid="cid-image" src="cid:fixture"><img data-testid="data-image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><a href="https://example.test">Safe link</a>`,
        hasBlockedRemoteImages: !remoteImages,
        remoteImages,
      } });
    });
    await page.route('**/api/mail/conversations/*/overrides', route => route.fulfill({ json: { ok: true, overrides: [] } }));
    await use(fixture);
  },
});

export { expect, fixture };
