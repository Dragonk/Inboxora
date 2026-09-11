import { expect } from '@playwright/test';

// Deterministic demo data for the documentation screenshots.
//
// The functional specs use abbreviated fixtures ("Gmail fixture", "sender@gmail.test")
// because they only assert behaviour. Published screenshots have a different job: they
// must show the product looking like a real, busy mailbox, in one consistent style, with
// the unified inbox, an expanded thread and an opened message.
//
// This module therefore registers English demo data on top of the shared `fixtures.js`
// API (routes registered later win in Playwright). `assertDocsPresentation` is the
// contract every capture must satisfy, so a future change cannot silently ship an empty,
// off-theme or unstyled screenshot.

/** Every documentation capture uses this theme, so the set stays visually consistent. */
export const DOCS_THEME = 'ink';

/**
 * The frozen wall clock for every capture. The demo data is dated around it, so dates,
 * times, relative labels and the calendar's "now" line are all deterministic.
 */
export const DOCS_CLOCK = '2026-09-10T10:15:00Z';

/** Pins the interface language (and therefore date formatting) before the app boots. */
export async function useEnglishLocale(page) {
  await page.addInitScript(() => {
    try { window.localStorage.setItem('mailflow_language', 'en'); } catch { /* private mode */ }
  });
}

export const demoAccounts = [
  {
    id: 'account-studio',
    name: 'Studio Northwind',
    email_address: 'anna@northwind.studio',
    color: '#3f6ad8',
    enabled: true,
    include_in_unified_inbox: true,
    sender_name: 'Anna Novak',
    folder_mappings: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Junk', archive: 'Archive' },
  },
  {
    id: 'account-personal',
    name: 'Personal',
    email_address: 'anna.novak@example.com',
    color: '#2f8f6b',
    enabled: true,
    include_in_unified_inbox: true,
    sender_name: 'Anna Novak',
    folder_mappings: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Junk', archive: 'Archive' },
  },
];

const folder = (accountId, path, name, unread, total, special = null) => ({
  account_id: accountId, path, name, unread_count: unread, total_count: total, special_use: special, delimiter: '/',
});

export const demoFolders = {
  'account-studio': [
    folder('account-studio', 'INBOX', 'Inbox', 2, 128, '\\Inbox'),
    folder('account-studio', 'INBOX/Leads', 'Leads', 1, 24),
    folder('account-studio', 'INBOX/Clients', 'Clients', 0, 61),
    folder('account-studio', 'Drafts', 'Drafts', 0, 3, '\\Drafts'),
    folder('account-studio', 'Sent', 'Sent', 0, 342, '\\Sent'),
    folder('account-studio', 'Archive', 'Archive', 0, 1180, '\\Archive'),
    folder('account-studio', 'Junk', 'Junk', 0, 12, '\\Junk'),
    folder('account-studio', 'Trash', 'Trash', 0, 46, '\\Trash'),
  ],
  'account-personal': [
    folder('account-personal', 'INBOX', 'Inbox', 1, 57, '\\Inbox'),
    folder('account-personal', 'Drafts', 'Drafts', 0, 1, '\\Drafts'),
    folder('account-personal', 'Sent', 'Sent', 0, 88, '\\Sent'),
    folder('account-personal', 'Archive', 'Archive', 0, 430, '\\Archive'),
    folder('account-personal', 'Trash', 'Trash', 0, 9, '\\Trash'),
  ],
};

// ─── Threads ──────────────────────────────────────────────────────────────────
//
// Each message is a physical copy: it carries its own folder, read state, snippet and
// body, exactly like the real conversation engine. `logical-<n>` and `copy-<n>` are both
// derived from the message position, so ids stay readable in test failures.

const sender = (name, email) => ({ name, email });

const PARTICIPANTS = {
  marcus: sender('Marcus Reid', 'marcus@northwind.studio'),
  priya: sender('Priya Raman', 'priya@northwind.studio'),
  billing: sender('Northwind Billing', 'billing@northwind.studio'),
  digest: sender('Product Design Weekly', 'hello@designweekly.example'),
  anna: sender('Anna Novak', 'anna@northwind.studio'),
};

const message = ({ from, folder, date, unread = false, snippet, text, html, attachments = [], listUnsubscribe = null }) => ({
  from, folder, date, unread, snippet, text, html, attachments, listUnsubscribe,
});

export const demoThreads = [
  {
    id: 'conversation-launch',
    subject: 'Q4 launch checklist — final review',
    accountId: 'account-studio',
    starred: true,
    messages: [
      message({
        from: 'marcus', folder: 'INBOX', date: '2026-09-10T07:40:00Z', unread: true,
        snippet: 'Here is the launch checklist we agreed on — four open items.',
        text: [
          'Hi Anna,',
          '',
          'Here is the launch checklist we agreed on. I marked the items that are still open.',
          '',
          '1. Landing page copy — final',
          '2. Pricing table — needs a second look',
          '3. Onboarding emails — approved',
          '4. Status page — waiting on infra',
          '',
          'Marcus',
        ].join('\n'),
        html: [
          '<p>Hi Anna,</p>',
          '<p>Here is the launch checklist we agreed on. I marked the items that are still open.</p>',
          '<ol>',
          '<li>Landing page copy &mdash; <strong>final</strong></li>',
          '<li>Pricing table &mdash; needs a second look</li>',
          '<li>Onboarding emails &mdash; approved</li>',
          '<li>Status page &mdash; waiting on infra</li>',
          '</ol>',
          '<p>Marcus</p>',
        ].join(''),
      }),
      message({
        from: 'anna', folder: 'Sent', date: '2026-09-10T08:15:00Z',
        snippet: 'Copy is final from my side. I attached the updated pricing table.',
        text: 'Thanks Marcus,\n\nCopy is final from my side. I attached the updated pricing table so we can compare both versions before Thursday.\n\nAnna',
        html: '<p>Thanks Marcus,</p><p>Copy is final from my side. I attached the updated pricing table so we can compare both versions before Thursday.</p><p>Anna</p>',
        attachments: [{ part: '2', filename: 'pricing-v4.pdf', size: 184320 }],
      }),
      message({
        from: 'priya', folder: 'INBOX', date: '2026-09-10T09:05:00Z', unread: true,
        snippet: 'Keep the annual toggle visible — support tickets drop noticeably.',
        text: 'Both versions look good. I would keep the annual toggle visible by default: support tickets drop noticeably when people see the yearly price first.\n\nPriya',
        html: '<p>Both versions look good. I would keep the annual toggle visible by default &mdash; support tickets drop noticeably when people see the yearly price first.</p><p>Priya</p>',
      }),
      message({
        from: 'anna', folder: 'Sent', date: '2026-09-10T10:20:00Z',
        snippet: 'Agreed — shipping the toggle change and freezing the branch.',
        text: 'Agreed. I will ship the toggle change today and freeze the branch for Thursday.\n\nAnna',
        html: '<p>Agreed. I will ship the toggle change today and freeze the branch for Thursday.</p><p>Anna</p>',
      }),
    ],
  },
  {
    id: 'conversation-design',
    subject: 'Design system handoff',
    accountId: 'account-studio',
    messages: [
      message({
        from: 'priya', folder: 'INBOX', date: '2026-09-09T14:10:00Z',
        snippet: 'Tokens, components and migration notes are ready for review.',
        text: 'Hi Anna,\n\nThe design system handoff is ready. Tokens, components and the migration notes are in the shared folder.\n\nLet me know if the naming works for you.\n\nPriya',
        html: '<p>Hi Anna,</p><p>The design system handoff is ready. Tokens, components and the migration notes are in the shared folder.</p><p>Let me know if the naming works for you.</p><p>Priya</p>',
        attachments: [{ part: '2', filename: 'design-tokens.json', size: 24576 }],
      }),
      message({
        from: 'anna', folder: 'Sent', date: '2026-09-09T15:02:00Z',
        snippet: 'Naming works — I renamed two spacing tokens and pushed the change.',
        text: 'Naming works. I renamed two spacing tokens to match the code side and pushed the change.\n\nAnna',
        html: '<p>Naming works. I renamed two spacing tokens to match the code side and pushed the change.</p><p>Anna</p>',
      }),
      message({
        from: 'priya', folder: 'INBOX', date: '2026-09-09T15:30:00Z',
        snippet: 'Perfect — I will update the documentation to match.',
        text: 'Perfect. I will update the documentation to match.\n\nPriya',
        html: '<p>Perfect &mdash; I will update the documentation to match.</p><p>Priya</p>',
      }),
    ],
  },
  {
    id: 'conversation-invoice',
    subject: 'Invoice 2026-114 — September retainer',
    accountId: 'account-studio',
    messages: [
      message({
        from: 'billing', folder: 'INBOX', date: '2026-09-08T11:00:00Z',
        snippet: 'Invoice 2026-114 is attached. Payment terms are 30 days.',
        text: 'Hello Anna,\n\nPlease find invoice 2026-114 for the September retainer attached. Payment terms are 30 days.\n\nKind regards,\nNorthwind Billing',
        html: '<p>Hello Anna,</p><p>Please find invoice <strong>2026-114</strong> for the September retainer attached. Payment terms are 30 days.</p><p>Kind regards,<br>Northwind Billing</p>',
        attachments: [{ part: '2', filename: 'invoice-2026-114.pdf', size: 96256 }],
      }),
      message({
        from: 'anna', folder: 'Sent', date: '2026-09-08T12:30:00Z',
        snippet: 'Approved and queued for payment on the 28th.',
        text: 'Approved and queued for payment on the 28th.\n\nAnna',
        html: '<p>Approved and queued for payment on the 28th.</p><p>Anna</p>',
      }),
    ],
  },
  {
    id: 'conversation-digest',
    subject: 'This week in product design',
    accountId: 'account-personal',
    messages: [
      message({
        from: 'digest', folder: 'INBOX', date: '2026-09-07T06:30:00Z', unread: true,
        snippet: 'Three practical articles on design systems, plus a short interview.',
        text: 'This week: three practical articles on design systems, plus a short interview about writing documentation people actually read.',
        html: [
          '<h2>This week in product design</h2>',
          '<p>Three practical articles on design systems, plus a short interview about writing documentation people actually read.</p>',
          '<ul><li>Naming tokens so nobody argues</li><li>Reviewing a pull request for interface copy</li><li>What a good changelog looks like</li></ul>',
        ].join(''),
        listUnsubscribe: 'https://designweekly.example/unsubscribe',
      }),
    ],
  },
];

/** Index every physical copy by id, with its logical position inside the thread. */
const COPY_INDEX = new Map();
for (const [threadIndex, entry] of demoThreads.entries()) {
  entry.messages.forEach((item, messageIndex) => {
    COPY_INDEX.set(`${entry.id.replace('conversation-', '')}-copy-${messageIndex + 1}`, { entry, threadIndex, messageIndex });
  });
}

const copyId = (entry, messageIndex) => `${entry.id.replace('conversation-', '')}-copy-${messageIndex + 1}`;
const logicalId = (entry, messageIndex) => `${entry.id.replace('conversation-', '')}-logical-${messageIndex + 1}`;
const recipientOf = entry => PARTICIPANTS[entry.messages[0].from];

/** The physical copies of one thread, in the shape the conversation engine returns. */
function copiesFor(entry) {
  return entry.messages.map((item, messageIndex) => {
    const outgoing = item.folder === 'Sent';
    const recipient = recipientOf(entry);
    return {
      id: copyId(entry, messageIndex),
      accountId: entry.accountId,
      messageId: `<${copyId(entry, messageIndex)}@northwind.studio>`,
      subject: entry.subject,
      fromName: PARTICIPANTS[item.from].name,
      fromEmail: PARTICIPANTS[item.from].email,
      to: outgoing
        ? [{ name: recipient.name, email: recipient.email }]
        : [{ name: sender('Anna Novak', demoAccounts[0].email_address).name, email: demoAccounts[0].email_address }],
      snippet: item.snippet,
      folder: item.folder,
      date: item.date,
      isRead: !item.unread,
      isStarred: Boolean(entry.starred) && messageIndex === entry.messages.length - 1,
      listUnsubscribe: item.listUnsubscribe,
      attachments: item.attachments,
    };
  });
}

/** `/api/mail/conversations/<id>` detail: summary plus logical messages. */
function conversationPayload(entry) {
  const copies = copiesFor(entry);
  const latest = copies.at(-1);
  return {
    summary: {
      conversation_id: entry.id,
      canonical_subject: entry.subject,
      account_id: entry.accountId,
      logical_message_count: copies.length,
      visible_copy_count: copies.length,
      copy_count: copies.length,
      unread_count: entry.messages.filter(item => item.unread).length,
      is_starred: Boolean(entry.starred),
      latest_message_is_mine: latest.folder === 'Sent',
      latest_copy_id: latest.id,
      subject: entry.subject,
      from_name: latest.fromName,
      from_email: latest.fromEmail,
      snippet: latest.snippet,
      date: latest.date,
      folder: latest.folder,
    },
    logicalMessages: copies.map((copy, messageIndex) => ({
      id: logicalId(entry, messageIndex),
      subject: entry.subject,
      messageDate: copy.date,
      // Deliberately stale: the reader must take direction from the physical copy.
      direction: 'incoming',
      copies: [copy],
    })),
  };
}

/** `/api/mail/messages` rows, flat: one entry per physical copy, newest first. */
export function demoFlatMessages() {
  return demoThreads
    .flatMap(entry => copiesFor(entry).map((copy, messageIndex) => ({
      id: copy.id,
      subject: copy.subject,
      from_name: copy.fromName,
      from_email: copy.fromEmail,
      snippet: copy.snippet,
      date: copy.date,
      folder: copy.folder,
      account_id: copy.accountId,
      is_read: copy.isRead,
      is_starred: copy.isStarred,
      has_attachments: copy.attachments.length > 0,
      message_id: copy.messageId,
      thread_id: entry.id,
      thread_key: entry.id,
      message_count: entry.messages.length,
      unread_count: entry.messages.filter(item => item.unread).length,
      position: messageIndex + 1,
    })))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/** `/api/mail/messages?threaded=true` rows: one aggregate per conversation. */
export function demoThreadedMessages() {
  return demoThreads
    .map(entry => {
      const copies = copiesFor(entry);
      const latest = copies.at(-1);
      return {
        id: latest.id,
        subject: entry.subject,
        from_name: latest.fromName,
        from_email: latest.fromEmail,
        snippet: latest.snippet,
        date: latest.date,
        folder: latest.folder,
        account_id: entry.accountId,
        is_read: entry.messages.every(item => !item.unread),
        is_starred: Boolean(entry.starred),
        has_attachments: copies.some(copy => copy.attachments.length > 0),
        message_id: latest.messageId,
        thread_id: entry.id,
        thread_key: entry.id,
        message_count: entry.messages.length,
        unread_count: entry.messages.filter(item => item.unread).length,
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/** The id of the newest row rendered by the list. */
export const newestDemoRowId = () => demoThreadedMessages()[0].id;

/** Ids of the headline demo thread, so specs never hardcode an id. Both are 1-based. */
export const demoConversationId = () => demoThreads[0].id;
export const demoLogicalId = position => logicalId(demoThreads[0], position - 1);
export const demoCopyId = position => copyId(demoThreads[0], position - 1);

/** Bodies keyed by physical copy id, so every expanded message renders real content. */
const demoBodies = Object.fromEntries(
  demoThreads.flatMap(entry => entry.messages.map((item, messageIndex) => [
    copyId(entry, messageIndex),
    { text: item.text, html: item.html, attachments: item.attachments },
  ])),
);

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Registers the English mail demo data. Called after the shared `fixtureApi`, so these
 * handlers take precedence wherever they overlap.
 */
export async function useEnglishMailData(page) {
  await page.route('**/api/accounts', route => route.fulfill({ json: demoAccounts }));
  await page.route(url => /\/api\/accounts\/[^/]+\/folders$/.test(url.pathname), route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    return route.fulfill({ json: demoFolders[id] || demoFolders['account-studio'] });
  });
  await page.route('**/api/mail/unread-counts', route => route.fulfill({
    json: { total: 4, byAccount: { 'account-studio': 2, 'account-personal': 1 } },
  }));

  // The flat reader asks for `/messages/<copyId>/body`, while the conversation reader
  // asks for `/conversations/<id>/logical-messages/<logicalId>/body?copyId=<copyId>`.
  const bodyFor = request => {
    const url = new URL(request.url());
    const id = url.searchParams.get('copyId')
      || url.pathname.match(/\/messages\/([^/]+)\/body$/)?.[1]
      || url.pathname.match(/\/logical-messages\/([^/]+)\/body$/)?.[1];
    return demoBodies[id];
  };

  // The conversation reader loads a logical message's body through the conversations
  // endpoint, while the flat reader uses the messages endpoint. Both are served from the
  // same demo bodies so the two paths cannot drift apart.
  await page.route(url => /\/api\/mail\/(?:conversations\/[^/]+\/logical-messages\/[^/]+|messages\/[^/]+)\/body$/.test(url.pathname), route => {
    const body = bodyFor(route.request());
    return route.fulfill({ json: {
      attachments: body?.attachments || [],
      text: body?.text || '',
      html: body?.html || '',
      hasBlockedRemoteImages: false,
      remoteImages: false,
    } });
  });

  await page.route(url => /\/api\/mail\/messages\/[^/]+\/conversation$/.test(url.pathname), route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const found = COPY_INDEX.get(id);
    const entry = found?.entry || demoThreads[0];
    const messageIndex = found?.messageIndex ?? 0;
    return route.fulfill({ json: {
      id,
      account_id: entry.accountId,
      conversation_id: entry.id,
      logical_message_id: logicalId(entry, messageIndex),
    } });
  });

  await page.route('**/api/mail/thread/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const entry = demoThreads.find(item => item.id === id);
    if (!entry) return route.fulfill({ json: { messages: [] } });
    return route.fulfill({ json: { messages: copiesFor(entry).map((copy, messageIndex) => ({
      id: copy.id,
      account_id: copy.accountId,
      message_id: copy.messageId,
      subject: copy.subject,
      from_name: copy.fromName,
      from_email: copy.fromEmail,
      folder: copy.folder,
      date: copy.date,
      is_read: copy.isRead,
      message_count: entry.messages.length,
      position: messageIndex + 1,
    })) } });
  });

  await page.route('**/api/mail/conversations**', route => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts.at(-1);
    if (parts.includes('logical-messages') || ['archive', 'move', 'delete', 'read', 'star'].includes(id)) return route.fallback();
    if (id && id !== 'conversations') {
      const entry = demoThreads.find(item => item.id === id);
      if (!entry) return route.fulfill({ status: 404, json: { error: 'Not found' } });
      return route.fulfill({ json: conversationPayload(entry) });
    }
    return route.fulfill({ json: {
      conversations: demoThreads.map(entry => conversationPayload(entry).summary),
      nextCursor: null,
      total: demoThreads.length,
    } });
  });

  // Keep destructive actions harmless if a capture ever triggers one.
  await page.route('**/api/mail/messages/bulk-*', route => route.fulfill({ json: { ok: true } }));

  await page.route('**/api/mail/messages**', route => {
    const url = new URL(route.request().url());
    if (/\/(?:conversation|body)$/.test(url.pathname)) return route.fallback();
    const threaded = url.searchParams.get('threaded') === 'true';
    const messages = threaded ? demoThreadedMessages() : demoFlatMessages();
    return route.fulfill({ json: { messages, total: messages.length, ...(threaded ? { threaded: true } : {}) } });
  });
}

/** Calendar and contact demo data, in the same English voice as the mail data. */
export async function useEnglishWorkspaceData(page) {
  const calendars = [
    { id: 'calendar-personal', name: 'Personal', color: '#35548a', source: 'local', read_only: false, owner_user_id: 'e2e-user' },
    { id: 'calendar-team', name: 'Team · CalDAV', color: '#35793a', source: 'caldav', read_only: true },
  ];
  const day = date => `2026-09-${String(date).padStart(2, '0')}`;
  const timed = (id, summary, start, end, calendar = 'calendar-personal', color = '#35548a', date = 10) => ({
    id, calendar_id: calendar, calendar_color: color,
    source: calendar === 'calendar-personal' ? 'local' : 'caldav',
    read_only: calendar !== 'calendar-personal', summary, location: 'Northwind Studio',
    description: 'Agenda and notes are attached to the invitation.',
    starts_at: `${day(date)}T${start}:00Z`, ends_at: `${day(date)}T${end}:00Z`,
  });
  const events = [
    timed('event-1', 'Design review', '08:00', '09:00'),
    timed('event-2', 'Sprint planning', '09:30', '10:30'),
    timed('event-3', 'Customer call · Halden', '11:00', '12:00'),
    timed('event-4', 'One-to-one with Priya', '13:00', '13:30'),
    timed('event-5', 'Roadmap wrap-up', '15:00', '16:00'),
    timed('event-6', 'Publish release notes', '09:00', '10:00', 'calendar-personal', '#35548a', 14),
    { ...timed('event-7', 'Team offsite', '00:00', '00:00', 'calendar-team', '#35793a'), all_day: true, starts_at: `${day(10)}T00:00:00Z`, ends_at: `${day(12)}T00:00:00Z` },
    { ...timed('event-8', 'Public holiday', '00:00', '00:00', 'calendar-team', '#35793a', 21), all_day: true, starts_at: `${day(21)}T00:00:00Z`, ends_at: `${day(22)}T00:00:00Z` },
  ];

  const books = [
    { id: 'book-work', name: 'Work', source: 'local', visible: true },
    { id: 'book-personal', name: 'Personal', source: 'local', visible: true },
    { id: 'book-team', name: 'Team · CardDAV', source: 'carddav', visible: true },
  ];
  const contact = {
    id: 'docs-priya', display_name: 'Priya Raman', first_name: 'Priya', last_name: 'Raman',
    primary_email: 'priya@northwind.studio', address_book_id: 'book-work', organization: 'Northwind Studio',
    title: 'Product designer', role: 'Design systems', nickname: 'Pri', read_only: false,
    emails: [{ value: 'priya@northwind.studio', type: 'work', primary: true }, { value: 'priya.raman@example.com', type: 'home' }],
    phones: [{ value: '+48 600 123 456', type: 'mobile' }],
    urls: [{ value: 'https://northwind.studio', type: 'work' }],
    instantMessages: [{ value: 'priya:matrix.org', type: 'Matrix' }],
    addresses: [{ type: 'work', street: '12 Long Street', extended: 'Floor 2', locality: 'Warsaw', region: 'Mazovia', postalCode: '00-001', country: 'Poland' }],
    contactDates: [{ label: 'Birthday', value: '1990-09-10' }, { label: 'Anniversary', value: '2018-06-12' }],
    categories: ['Design', 'Team'], notes: 'Owns the design system. Prefers calls in the morning.',
    send_count: 42, last_sent: '2026-09-08T10:00:00Z',
  };

  await page.route('**/api/calendar/calendars', route => route.fulfill({ json: { calendars } }));
  await page.route('**/api/calendar/sources**', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/calendar/events**', route => {
    const url = new URL(route.request().url());
    const from = new Date(url.searchParams.get('from'));
    const to = new Date(url.searchParams.get('to'));
    return route.fulfill({ json: { events: events.filter(event => new Date(event.starts_at) < to && new Date(event.ends_at) > from) } });
  });
  await page.route('**/api/contacts**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes('address-books')) return route.fulfill({ json: { addressBooks: books } });
    if (request.method() !== 'GET') return route.fulfill({ json: contact });
    if (url.pathname.endsWith('/docs-priya')) return route.fulfill({ json: contact });
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const visible = JSON.stringify(contact).toLowerCase().includes(query);
    return route.fulfill({ json: { contacts: visible ? [contact] : [], total: visible ? 1 : 0 } });
  });
}

/** DAV application passwords and version metadata for the Settings captures. */
export async function useDavDemoData(page) {
  await page.route('**/api/dav-credentials', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { credentials: [
      { id: 'cred-phone', label: 'Pixel 7 · DAVx5', created_at: '2026-08-14T09:12:00Z', last_used_at: '2026-09-11T07:41:00Z' },
      { id: 'cred-laptop', label: 'Thunderbird · laptop', created_at: '2026-07-02T18:30:00Z', last_used_at: null },
    ] } });
  });
  await page.route('**/api/version', route => route.fulfill({ json: { version: '4.0.0', sha: '4f4a2c19d5c8f0b7a1e34a9c6d2b8ef0173c5a64' } }));
}

// ─── Presentation contract ────────────────────────────────────────────────────

/**
 * Fails the capture unless the page really is showing the documentation presentation:
 * the shared theme, the unified inbox entry point, and populated content rather than an
 * empty state. Called by every capture in the docs spec.
 *
 * `mode` selects what "populated" means for the screen being captured:
 *   - `mail-list`   the message list has rows
 *   - `mail-reader` the reading pane shows a rendered message body
 *   - `workspace`   the caller must supply `require` locators proving the module rendered
 *                   real content, so a calendar or contacts capture cannot be empty either
 */
export async function assertDocsPresentation(page, { mode = 'mail-list', require: required = [] } = {}) {
  // `applyTheme` exposes the active palette on the root element; every capture in this
  // set must be the same theme, or the gallery looks like several different products.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-mailflow-theme')), {
      message: 'every documentation screenshot must use the shared documentation theme',
    })
    .toBe(DOCS_THEME);

  // The unified inbox only renders with two or more enabled accounts, so its presence
  // also proves the shared demo data reached the sidebar.
  await expect(page.getByTestId('all-inboxes'), 'the unified inbox entry point must be visible').toBeVisible();

  if (mode === 'mail-reader') {
    const bodyFrame = page.locator('section[data-conversation-id]:visible iframe').first();
    await expect(bodyFrame, 'the reader must show a message body, not an empty pane').toBeVisible();
    await expect(bodyFrame.contentFrame().locator('body'), 'the rendered message body must not be empty').not.toBeEmpty();
  } else if (mode === 'mail-list') {
    await expect(page.locator('[data-msgid]:visible').first(), 'the mail list must not be empty').toBeVisible();
  } else if (mode === 'workspace') {
    expect(required.length, 'a workspace capture must declare the content it expects to show').toBeGreaterThan(0);
  } else {
    throw new Error(`Unknown documentation capture mode: ${mode}`);
  }

  for (const locator of required) await expect(locator).toBeVisible();
}

export { expect };
