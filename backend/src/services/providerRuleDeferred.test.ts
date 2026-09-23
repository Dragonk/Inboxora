import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  gmailContent: vi.fn(), gmailHeaders: vi.fn(),
  graphBody: vi.fn(), graphHeaders: vi.fn(),
  apply: vi.fn(), events: [] as string[],
}));
vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerAuthService.js', () => ({ googleConfigFromEnv: vi.fn(() => ({})), microsoftConfigFromEnv: vi.fn(() => ({})) }));
vi.mock('./providers/google/gmailMailBody.js', () => ({ fetchGmailMessageContent: mocks.gmailContent, fetchGmailMessageHeaders: mocks.gmailHeaders }));
vi.mock('./providers/microsoft/graphMailBody.js', () => ({ fetchGraphMessageBody: mocks.graphBody, fetchGraphMessageHeaders: mocks.graphHeaders }));
vi.mock('./providerIngestRules.js', () => ({ applyIngestRulesToRows: mocks.apply }));

import { drainProviderRuleDeferrals } from './providerRuleDeferred.js';

const row = { id: 'job-1', message_id: 'message-1', account_id: 'account-1', user_id: 'user-1', connection_id: 'connection-1', transport: 'gmail_api', needs_body: true, needs_headers: false } as const;
const source = { id: 'message-1', provider_message_id: 'provider-1', body_text: null, parsed_headers: { subject: 'Known' }, folder: 'INBOX', is_deleted: false };

function claimOne() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('WITH candidates')) return { rows: [row], rowCount: 1 };
    if (sql.includes('SELECT id, provider_message_id')) return { rows: [source], rowCount: 1 };
    if (sql.includes('UPDATE messages SET body_text')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('DELETE FROM provider_rule_deferred_messages')) { mocks.events.push('settled'); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SET attempts = attempts + 1')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

describe('provider rule deferred worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.apply.mockImplementation(async () => { mocks.events.push('action'); });
    claimOne();
    mocks.gmailContent.mockResolvedValue({ text: 'invoice body', html: null, attachments: [] });
  });

  it('hydrates a due row then applies exactly once after deleting its read retry record', async () => {
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.gmailContent).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM provider_rule_deferred_messages'), ['job-1', 'worker-a']);
    expect(mocks.events).toEqual(['settled', 'action']);
  });

  it('backs off a provider read failure without applying an action', async () => {
    mocks.gmailContent.mockRejectedValue(new Error('temporary outage'));
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 0, retried: 1, discarded: 0 });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('SET attempts = attempts + 1'), expect.arrayContaining(['job-1', 'worker-a']));
  });

  it.each([null, ''])('keeps an absent or empty body unknown so a negative rule cannot run', async text => {
    mocks.gmailContent.mockResolvedValue({ text, html: null, attachments: [] });
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 0, retried: 1, discarded: 0 });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE messages SET body_text'), expect.anything());
  });

  it('does not act when another worker has no claimable lease', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(drainProviderRuleDeferrals({ owner: 'worker-b' })).resolves.toEqual({ applied: 0, retried: 0, discarded: 0 });
    expect(mocks.gmailContent).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
