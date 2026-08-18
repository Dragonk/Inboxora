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
      logical_message_count: 3,
      visible_copy_count: 4,
      latest_message_is_mine: true,
      latestCopyId: 'conversation-gmail-copy-3',
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

function details(id) {
  const row = fixture.conversations.find(item => item.conversation_id === id) || fixture.conversations[0];
  return {
    summary: { ...row, conversation_id: id, canonical_subject: row.canonical_subject },
    logicalMessages: Array.from({ length: row.logical_message_count }, (_, index) => ({
      id: `${id}-logical-${index + 1}`,
      subject: row.canonical_subject,
      direction: index === row.logical_message_count - 1 && row.latest_message_is_mine ? 'outgoing' : 'incoming',
      copies: [{
        id: `${id}-copy-${index + 1}`,
        accountId: index % 2 ? 'account-outlook' : 'account-gmail',
        messageId: `<${id}-${index + 1}@fixture.test>`,
        subject: row.canonical_subject,
        fromEmail: index % 2 ? 'sender@outlook.test' : 'sender@gmail.test',
        bodyText: `Fixture body ${index + 1}`,
        bodyHtml: `<p>Fixture body ${index + 1}</p><blockquote>Quoted previous message</blockquote>`,
      }, ...(index === 0 ? [{
        id: `${id}-copy-${index + 1}-duplicate`,
        accountId: 'account-fastmail',
        messageId: `<${id}-${index + 1}-fastmail@fixture.test>`,
        subject: row.canonical_subject,
        fromEmail: 'sender@fastmail.test',
        bodyText: `Fixture body ${index + 1} duplicate`,
        bodyHtml: `<p>Fixture body ${index + 1} duplicate</p>`,
      }] : [])],
    })),
  };
}

export const test = base.extend({
  fixtureApi: async ({ page }, use) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { user: fixture.user } }));
    await page.route('**/api/auth/preferences', async route => {
      if (route.request().method() === 'PATCH') return route.fulfill({ json: { ok: true } });
      return route.fulfill({ json: {
        language: 'pl',
        theme: 'light',
        conversation_list_view_enabled: true,
        conversation_reader_view_enabled: true,
        block_remote_images: true,
      } });
    });
    await page.route('**/api/accounts', route => route.fulfill({ json: fixture.accounts }));
    await page.route('**/api/mail/unread-counts', route => route.fulfill({ json: { total: 0, byAccount: {} } }));
    await page.route('**/api/mail/conversations/*/logical-messages/*/body', route => route.fulfill({ json: { body_text: 'Fixture body lazy', body_html: '<p>Fixture body lazy</p><img src=\"https://tracker.example.test/pixel.gif\"><a href=\"https://example.test\">Safe link</a>' } }));
    await page.route('**/api/mail/conversations**', route => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts.at(-1);
      if (parts.includes('logical-messages')) return route.fallback();
      if (id && id !== 'conversations') return route.fulfill({ json: details(id) });
      return route.fulfill({ json: { conversations: fixture.conversations, nextCursor: null } });
    });
    await page.route('**/api/mail/messages/*/conversation', route => route.fulfill({ json: { conversation_id: 'conversation-gmail', logical_message_id: 'conversation-gmail-logical-1' } }));
    await page.route('**/api/mail/conversations/*/overrides', route => route.fulfill({ json: { ok: true, overrides: [] } }));
    await use(fixture);
  },
});

export { expect, fixture };
