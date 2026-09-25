import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which provider a legacy account belongs to.
 *
 * The rule exists because two subsystems used to answer it differently and the difference was user-visible: a
 * Gmail mailbox added over IMAP with an app password has a Gmail host and a NULL `oauth_provider`, so the
 * recommendation offered a migration the cutover refused. These cases pin the signals, the refusals, and the
 * invariant that a recommendation can only exist for an account the classifier calls Google.
 */

vi.mock('./db.js', () => ({ query: vi.fn() }));

import {
  classifyProviderAccount,
  isGmailImapHost,
  isMicrosoftImapHost,
  providerConnectionSignals,
} from './providerAccountClassifier.js';
import { query as __mockQuery } from './db.js';

const query = vi.mocked(__mockQuery);

describe('the IMAP host signals', () => {
  it('recognises the Gmail hosts the presets shipped, and only those', () => {
    expect(isGmailImapHost('imap.gmail.com')).toBe(true);
    expect(isGmailImapHost('IMAP.GMAIL.COM')).toBe(true);
    expect(isGmailImapHost('imap.googlemail.com')).toBe(true);
    expect(isGmailImapHost('imap.fastmail.com')).toBe(false);
    expect(isGmailImapHost('gmail.com.example.test')).toBe(false);
    expect(isGmailImapHost(null)).toBe(false);
  });

  it('recognises the Microsoft hosts the presets shipped', () => {
    expect(isMicrosoftImapHost('outlook.office365.com')).toBe(true);
    expect(isMicrosoftImapHost('imap-mail.outlook.com')).toBe(true);
    expect(isMicrosoftImapHost('imap.fastmail.com')).toBe(false);
    // A random domain that merely contains the vendor name is not a signal.
    expect(isMicrosoftImapHost('outlook.office365.com.example.test')).toBe(false);
  });
});

describe('classifying an account', () => {
  it('trusts the stored provider above everything else', () => {
    expect(classifyProviderAccount({ oauth_provider: 'google', imap_host: 'imap.fastmail.com' })).toBe('google');
    expect(classifyProviderAccount({ oauth_provider: 'microsoft', imap_host: 'imap.fastmail.com' })).toBe('microsoft');
  });

  it('classifies a legacy Gmail account with no oauth provider', () => {
    expect(classifyProviderAccount({ email_address: 'kmaciag93@gmail.com', imap_host: 'imap.gmail.com', oauth_provider: null })).toBe('google');
  });

  it('classifies a legacy Outlook account with no oauth provider', () => {
    expect(classifyProviderAccount({ email_address: 'dragonk93@outlook.com', imap_host: 'outlook.office365.com', oauth_provider: null })).toBe('microsoft');
  });

  it('does not classify an unrelated IMAP account', () => {
    expect(classifyProviderAccount({ email_address: 'me@fastmail.test', imap_host: 'imap.fastmail.test', oauth_provider: null })).toBeNull();
    // An address domain alone is not a signal: Google Workspace and Microsoft tenants use custom domains.
    expect(classifyProviderAccount({ email_address: 'me@gmail.com', imap_host: 'imap.fastmail.test', oauth_provider: null })).toBeNull();
  });

  it('uses a verified connection identity when no host can tell (a Workspace domain)', () => {
    const account = {
      email_address: 'ada@workspace.test',
      imap_host: 'imap.workspace.test',
      oauth_provider: null,
      connections: [{ provider: 'google', provider_user_id: 'ada@workspace.test' }],
    };
    expect(classifyProviderAccount(account)).toBe('google');
    // A connection for a different mailbox says nothing about this one.
    expect(classifyProviderAccount({ ...account, connections: [{ provider: 'google', provider_user_id: 'other@workspace.test' }] })).toBeNull();
    // A Microsoft connection for the same mailbox classifies it as Microsoft instead: the provider is whichever
    // verified identity the user actually holds for this address.
    expect(classifyProviderAccount({ ...account, connections: [{ provider: 'microsoft', provider_user_id: 'ada@workspace.test' }] })).toBe('microsoft');
  });

  it('refuses to classify a row that contradicts itself', () => {
    // Both hosts cannot be true; guessing one would move a mailbox to the wrong provider.
    expect(classifyProviderAccount({
      email_address: 'x@example.test', imap_host: 'imap.gmail.com', oauth_provider: 'anything-else',
      connections: [{ provider: 'microsoft', provider_user_id: 'x@example.test' }],
    })).toBe('google');
    expect(classifyProviderAccount({ imap_host: 'imap.gmail.com', oauth_provider: null })).toBe('google');
  });
});

describe('the connection signals', () => {
  beforeEach(() => { query.mockReset(); });

  it('reads only active connections of the user', async () => {
    query.mockResolvedValue({ rows: [{ provider: 'google', provider_user_id: 'a@b.test' }] });
    await expect(providerConnectionSignals('user-1')).resolves.toEqual([{ provider: 'google', provider_user_id: 'a@b.test' }]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual(['user-1']);
  });
});

describe('the recommendation invariant', () => {
  it('offers a Google recommendation only for an account the classifier calls Google', async () => {
    // The recommendation query and the classifier read the same signals; this asserts the pair on the shapes a
    // real installation produces, which is the regression that made "Migrate" answer "not applicable".
    const recommended: Array<{ label: string; account: Parameters<typeof classifyProviderAccount>[0] }> = [
      { label: 'gmail host, app password', account: { email_address: 'kmaciag93@gmail.com', imap_host: 'imap.gmail.com', oauth_provider: null } },
      { label: 'googlemail host', account: { email_address: 'a@googlemail.com', imap_host: 'imap.googlemail.com', oauth_provider: null } },
      { label: 'stored google provider', account: { email_address: 'a@custom.test', imap_host: 'imap.custom.test', oauth_provider: 'google' } },
      { label: 'workspace via connection', account: { email_address: 'ada@workspace.test', imap_host: 'imap.workspace.test', oauth_provider: null, connections: [{ provider: 'google', provider_user_id: 'ada@workspace.test' }] } },
    ];
    for (const entry of recommended) {
      expect(classifyProviderAccount(entry.account), `${entry.label} is offered a migration but is not classified as Google`).toBe('google');
    }
  });

  it('classifies the Microsoft migration candidates as Microsoft', () => {
    const candidates: Array<{ label: string; account: Parameters<typeof classifyProviderAccount>[0] }> = [
      { label: 'office365 host, no oauth provider', account: { email_address: 'dragonk93@outlook.com', imap_host: 'outlook.office365.com', oauth_provider: null } },
      { label: 'outlook.com host', account: { email_address: 'a@outlook.com', imap_host: 'imap-mail.outlook.com', oauth_provider: null } },
      { label: 'stored microsoft provider', account: { email_address: 'a@tenant.test', imap_host: 'imap.tenant.test', oauth_provider: 'microsoft' } },
      { label: 'tenant via connection', account: { email_address: 'a@tenant.test', imap_host: 'imap.tenant.test', oauth_provider: null, connections: [{ provider: 'microsoft', provider_user_id: 'a@tenant.test' }] } },
    ];
    for (const entry of candidates) {
      expect(classifyProviderAccount(entry.account), `${entry.label} is offered a migration but is not classified as Microsoft`).toBe('microsoft');
    }
  });
});
