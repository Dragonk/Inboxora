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
const source = { id: 'message-1', provider_message_id: 'provider-1', body_text: null, parsed_headers: { subject: 'Known' }, parsed_headers_complete: false, folder: 'INBOX', is_deleted: false };

function claimOne() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('WITH candidates')) return { rows: [row], rowCount: 1 };
    if (sql.includes('SELECT m.id, m.provider_message_id')) return { rows: [source], rowCount: 1 };
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

  it('hydrates a due row then retains a completed dispatch record after applying once', async () => {
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.gmailContent).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("dispatch_state = 'dispatching'"), ['job-1', 'worker-a']);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('dispatch_state = $3'), ['job-1', 'worker-a', 'completed', 'rule evaluation completed']);
    expect(mocks.events).toEqual(['action']);
  });

  it('durably marks the action boundary before handing the rule to its existing journal', async () => {
    mocks.apply.mockImplementationOnce(async (input: { beforeRuleAction?: (value: { messageId: string; ruleId: string; actionType?: string }) => Promise<boolean> }) => {
      expect(await input.beforeRuleAction?.({ messageId: 'message-1', ruleId: '00000000-0000-0000-0000-000000000001', actionType: 'move' })).toBe(true);
      mocks.events.push('action');
    });

    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('action_started_at = COALESCE'), [
      'job-1', 'worker-a', '00000000-0000-0000-0000-000000000001', 'message-1',
    ]);
    expect(mocks.events).toEqual(['action']);
  });

  it('permits every action in one matched rule batch after one durable dispatch boundary', async () => {
    mocks.apply.mockImplementationOnce(async (input: { beforeRuleAction?: (value: { messageId: string; ruleId: string; actionType?: string }) => Promise<boolean> }) => {
      expect(await input.beforeRuleAction?.({ messageId: 'message-1', ruleId: '00000000-0000-0000-0000-000000000003', actionType: 'mark_read' })).toBe(true);
      expect(await input.beforeRuleAction?.({ messageId: 'message-1', ruleId: '00000000-0000-0000-0000-000000000003', actionType: 'move' })).toBe(true);
      mocks.events.push('two-actions');
    });

    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.events).toEqual(['two-actions']);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('action_started_at = COALESCE'))).toHaveLength(2);
  });

  it('refuses dispatch when current message/account ownership no longer passes the final gate', async () => {
    mocks.apply.mockImplementationOnce(async (input: { beforeRuleAction?: (value: { messageId: string; ruleId: string; actionType?: string }) => Promise<boolean> }) => {
      expect(await input.beforeRuleAction?.({ messageId: 'message-1', ruleId: '00000000-0000-0000-0000-000000000002', actionType: 'delete' })).toBe(false);
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidates')) return { rows: [row], rowCount: 1 } as never;
      if (sql.includes('SELECT m.id, m.provider_message_id')) return { rows: [source], rowCount: 1 } as never;
      if (sql.includes('action_started_at = COALESCE')) return { rows: [], rowCount: 0 } as never;
      return { rows: [], rowCount: 1 } as never;
    });

    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('dispatch_state = $3'), [
      'job-1', 'worker-a', 'refused', 'message or account no longer eligible for rule action',
    ]);
  });

  it('backs off a provider read failure without applying an action', async () => {
    mocks.gmailContent.mockRejectedValue(new Error('temporary outage'));
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 0, retried: 1, discarded: 0 });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('SET attempts = attempts + 1'), expect.arrayContaining(['job-1', 'worker-a']));
  });

  it('keeps an absent body unknown so a negative rule cannot run', async () => {
    mocks.gmailContent.mockResolvedValue({ text: null, html: null, attachments: [] });
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 0, retried: 1, discarded: 0 });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('treats a confirmed empty body as complete and evaluates it once', async () => {
    mocks.gmailContent.mockResolvedValue({ text: '', html: null, attachments: [] });
    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('parsed_headers_complete'), expect.arrayContaining(['message-1', '']));
  });

  it('hydrates partial Gmail metadata before evaluating a header rule', async () => {
    const headerRow = { ...row, needs_body: false, needs_headers: true };
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidates')) return { rows: [headerRow], rowCount: 1 };
      if (sql.includes('SELECT m.id, m.provider_message_id')) return { rows: [{ ...source, body_text: 'known', parsed_headers_complete: false }], rowCount: 1 };
      if (sql.startsWith('DELETE FROM provider_rule_deferred_messages')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mocks.gmailHeaders.mockResolvedValue('X-Customer: alpha\r\nSubject: Known\r\n');

    await expect(drainProviderRuleDeferrals({ owner: 'worker-a' })).resolves.toEqual({ applied: 1, retried: 0, discarded: 0 });
    expect(mocks.gmailHeaders).toHaveBeenCalledWith(expect.anything(), 'provider-1');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('parsed_headers_complete'), expect.arrayContaining(['message-1', null, expect.stringContaining('x-customer')]));
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it('parks an expired post-action dispatch as outcome_unknown without re-dispatching it', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidates')) return { rows: [], rowCount: 0 } as never;
      if (sql.includes("dispatch_state = 'outcome_unknown'")) return { rows: [], rowCount: 1 } as never;
      return { rows: [], rowCount: 0 } as never;
    });

    await expect(drainProviderRuleDeferrals({ owner: 'restarted-worker' })).resolves.toEqual({ applied: 0, retried: 0, discarded: 0 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("dispatch_state = 'outcome_unknown'"));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('does not act when another worker has no claimable lease', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(drainProviderRuleDeferrals({ owner: 'worker-b' })).resolves.toEqual({ applied: 0, retried: 0, discarded: 0 });
    expect(mocks.gmailContent).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
