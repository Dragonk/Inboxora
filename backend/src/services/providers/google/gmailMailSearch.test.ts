import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  query: vi.fn(),
  fetchIds: vi.fn(),
  fetchMessage: vi.fn(),
  localMessage: vi.fn(),
  apply: vi.fn(),
  paths: vi.fn(),
  syncLabels: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  query: f.query,
  withTransaction: async (callback: (client: object) => unknown) => callback({}),
}));
vi.mock('../../providerAuthService.js', () => ({ googleConfigFromEnv: () => ({}) }));
vi.mock('../../conversationRowIngest.js', () => ({ persistConversationCopyForRow: f.persist }));
vi.mock('../../mailSearchRemoteQuery.js', () => ({ gmailSearchQuery: (value: string) => value }));
vi.mock('./gmailMail.js', () => ({
  fetchGmailMessageIds: f.fetchIds,
  fetchGmailMessage: f.fetchMessage,
  localMessageForGmailMessage: f.localMessage,
}));
vi.mock('./gmailMailSync.js', () => ({
  applyGmailMessage: f.apply,
  gmailFolderPathByLabelId: f.paths,
  syncGmailMailLabelsForAccount: f.syncLabels,
}));

import { ingestGmailMailSearch } from './gmailMailSearch.js';

describe('Gmail provider mail search hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.paths.mockResolvedValue(new Map([['INBOX', 'INBOX']]));
    f.fetchIds.mockResolvedValue({ messages: [{ id: 'already-local' }, { id: 'missing-local' }], nextPageToken: null });
    f.query.mockResolvedValue({ rows: [{ id: 'local-row', provider_message_id: 'already-local' }] });
    f.fetchMessage.mockResolvedValue({ id: 'missing-local' });
    f.localMessage.mockReturnValue({ providerMessageId: 'missing-local' });
    f.apply.mockResolvedValue({ id: 'new-row' });
    f.persist.mockResolvedValue(undefined);
  });

  it('reuses local provider rows and hydrates only missing Gmail search hits', async () => {
    const result = await ingestGmailMailSearch({
      userId: 'user-1',
      accountId: 'account-1',
      connectionId: 'google-1',
      query: 'invoice',
      folders: null,
      maxResults: 51,
    });

    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('provider_message_id=ANY'), [
      'account-1',
      'user-1',
      ['already-local', 'missing-local'],
    ]);
    expect(f.fetchMessage).toHaveBeenCalledTimes(1);
    expect(f.fetchMessage).toHaveBeenCalledWith(expect.any(Object), 'missing-local', 'full', expect.any(String));
    expect(f.localMessage).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.persist).toHaveBeenCalledWith('new-row', { id: 'account-1', user_id: 'user-1' });
    expect(new Set(result.rowIds)).toEqual(new Set(['local-row', 'new-row']));
    expect(result.truncated).toBe(false);
  });
});
