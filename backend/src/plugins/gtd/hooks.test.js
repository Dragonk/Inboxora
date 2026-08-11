import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({
  getGtdFolderSet: vi.fn(), getGtdConfig: vi.fn(),
  sanitizeGtdFoldersDetailed: vi.fn(), findGtdFolderCollisions: vi.fn(),
  DEFAULT_GTD_FOLDERS: { todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference' },
  invalidateGtdConfigCache: vi.fn(),
}));
vi.mock('./gtdTransitions.js', () => ({ runGtdTransitions: vi.fn(), threadKeysForMessageIds: vi.fn(), threadKeysInFolders: vi.fn(), runTransitionsForSentMessage: vi.fn(), invalidateOwnerAddressesCache: vi.fn() }));
vi.mock('./gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn() }));
vi.mock('./gtdPet.js', () => ({ customPetSlug: vi.fn() }));
import { query } from '../../services/db.js';
import { getGtdFolderSet, getGtdConfig, sanitizeGtdFoldersDetailed, findGtdFolderCollisions, invalidateGtdConfigCache } from './gtdConfig.js';
import { runGtdTransitions, threadKeysForMessageIds, runTransitionsForSentMessage, invalidateOwnerAddressesCache } from './gtdTransitions.js';
import { emitGtdIfRelevant } from './gtdSections.js';
import { customPetSlug } from './gtdPet.js';
import { relocateExemptFolders, sectionsChanged, inboxIngest, selectGtdReevalIds, gtdEnabledForAccount, emitAfterDeferredCopySync, afterLabelCopy, afterLabelRemove, onMailMutation, onSentMessage, onUserDelete, validateAccountSettings, onAccountSettingsChanged, onAccountIdentityChanged } from './hooks.js';

describe('gtd hooks — relocateExemptFolders', () => {
  beforeEach(() => getGtdFolderSet.mockReset());

  it('returns the account\'s designated GTD folders as a plain array', async () => {
    getGtdFolderSet.mockResolvedValueOnce(new Set(['Todo', 'Watch', 'Delegated']));
    const folders = await relocateExemptFolders({ accountId: 'a1' });
    expect(getGtdFolderSet).toHaveBeenCalledWith('a1');
    expect(folders).toEqual(['Todo', 'Watch', 'Delegated']);
  });

  it('contributes nothing when GTD is disabled (empty set)', async () => {
    getGtdFolderSet.mockResolvedValueOnce(new Set());
    expect(await relocateExemptFolders({ accountId: 'a1' })).toEqual([]);
  });
});

describe('gtd hooks — sectionsChanged', () => {
  beforeEach(() => getGtdConfig.mockReset());
  const mgr = () => ({ broadcast: vi.fn() });
  const account = { id: 'a1', user_id: 'u1' };

  it('broadcasts gtd_sections_updated once when GTD is enabled and rows changed', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: true });
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 4 });
    expect(imap.broadcast).toHaveBeenCalledTimes(1);
    expect(imap.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('does not broadcast when GTD is disabled for the account', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: false });
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 4 });
    expect(imap.broadcast).not.toHaveBeenCalled();
  });

  it('does not read config or broadcast when changedCount is not > 0', async () => {
    const imap = mgr();
    await sectionsChanged({ mgr: imap, account, changedCount: 0 });
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(imap.broadcast).not.toHaveBeenCalled();
  });

  it('swallows a config-lookup failure without broadcasting or throwing', async () => {
    getGtdConfig.mockRejectedValueOnce(new Error('db boom'));
    const imap = mgr();
    await expect(sectionsChanged({ mgr: imap, account, changedCount: 2 })).resolves.toBeUndefined();
    expect(imap.broadcast).not.toHaveBeenCalled();
  });
});

describe('gtd hooks — selectGtdReevalIds', () => {
  it('includes an already-read is_new arrival (read state is not a gate)', () => {
    expect(selectGtdReevalIds(['read-reply'], [])).toEqual(['read-reply']);
  });

  it('excludes a genuinely-deleted candidate but keeps a rule-MOVED one', () => {
    expect(selectGtdReevalIds(['deleted', 'moved', 'stayed'], ['deleted'])).toEqual(['moved', 'stayed']);
  });

  it('accepts the deleted ids as a Set and returns [] when all candidates were deleted', () => {
    expect(selectGtdReevalIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  it('returns [] for an empty candidate list', () => {
    expect(selectGtdReevalIds([], ['x'])).toEqual([]);
  });
});

describe('gtd hooks — inboxIngest', () => {
  beforeEach(() => { runGtdTransitions.mockReset(); threadKeysForMessageIds.mockReset(); });
  const account = { id: 'a1', user_id: 'u1' };

  it('resolves candidate ids to thread keys and runs transitions over them', async () => {
    threadKeysForMessageIds.mockResolvedValueOnce(['thr-1', 'thr-2']);
    const mgr = {};
    await inboxIngest({ mgr, account, newInboxIds: ['m1', 'm2'], deletedIds: new Set() });
    expect(threadKeysForMessageIds).toHaveBeenCalledWith('a1', ['m1', 'm2']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-1', 'thr-2']);
  });

  it('drops rule-deleted candidates before resolving threads', async () => {
    threadKeysForMessageIds.mockResolvedValueOnce(['thr-moved']);
    await inboxIngest({ mgr: {}, account, newInboxIds: ['deleted', 'moved'], deletedIds: new Set(['deleted']) });
    expect(threadKeysForMessageIds).toHaveBeenCalledWith('a1', ['moved']);
  });

  it('does no work when every candidate was deleted', async () => {
    await inboxIngest({ mgr: {}, account, newInboxIds: ['x'], deletedIds: new Set(['x']) });
    expect(threadKeysForMessageIds).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('swallows a transition failure without throwing into core', async () => {
    threadKeysForMessageIds.mockRejectedValueOnce(new Error('db boom'));
    await expect(inboxIngest({ mgr: {}, account, newInboxIds: ['m1'], deletedIds: new Set() }))
      .resolves.toBeUndefined();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('gtdEnabledForAccount reflects account.gtd_enabled', () => {
    expect(gtdEnabledForAccount({ account: { gtd_enabled: true } })).toBe(true);
    expect(gtdEnabledForAccount({ account: { gtd_enabled: false } })).toBe(false);
    expect(gtdEnabledForAccount({})).toBe(false);
    expect(gtdEnabledForAccount(undefined)).toBe(false);
  });
});

describe('gtd hooks — emitAfterDeferredCopySync', () => {
  beforeEach(() => { query.mockReset(); runGtdTransitions.mockReset(); });

  it('re-emits gtd_sections_updated after the deferred destination sync resolves', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' }; // gtd_enabled falsy → no transition re-run
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Todo');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' }, 'user-1');
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('does not emit when the deferred sync fails', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockRejectedValue(new Error('sync boom')), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' };
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('re-runs the transition engine over the copied message thread once the sibling syncs', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1', gtd_enabled: true };
    query.mockResolvedValueOnce({ rows: [{ thread_key: 'thr-9' }] });
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(query.mock.calls[0][1]).toEqual(['acct-1', 100, 'INBOX']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-9']);
  });

  it('swallows a transition re-run failure after still emitting', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1', gtd_enabled: true };
    query.mockRejectedValueOnce(new Error('db boom'));
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });
});

describe('gtd hooks — afterLabelCopy / afterLabelRemove', () => {
  beforeEach(() => { query.mockReset(); runGtdTransitions.mockReset(); });

  it('afterLabelCopy broadcasts and, on the UIDPLUS path (newUid set), does no deferred sync', async () => {
    const mgr = { broadcast: vi.fn(), syncFolderOnDemand: vi.fn() };
    const account = { id: 'a1', user_id: 'u1' };
    await afterLabelCopy({ mgr, account, toFolder: 'Todo', fromFolder: 'INBOX', srcUid: 5, newUid: 42 });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
    expect(mgr.syncFolderOnDemand).not.toHaveBeenCalled();
  });

  it('afterLabelCopy kicks off the deferred reconcile on the non-UIDPLUS path (newUid null)', async () => {
    const mgr = { broadcast: vi.fn(), syncFolderOnDemand: vi.fn().mockResolvedValue(undefined) };
    const account = { id: 'a1', user_id: 'u1' };
    await afterLabelCopy({ mgr, account, toFolder: 'Todo', fromFolder: 'INBOX', srcUid: 5, newUid: null });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Todo');
  });

  it('afterLabelRemove broadcasts the section refresh', async () => {
    const mgr = { broadcast: vi.fn() };
    await afterLabelRemove({ mgr, account: { id: 'a1', user_id: 'u1' } });
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });
});

describe('gtd hooks — route-layer adapters (onMailMutation / onSentMessage / onUserDelete)', () => {
  beforeEach(() => { emitGtdIfRelevant.mockReset(); runTransitionsForSentMessage.mockReset(); customPetSlug.mockReset(); query.mockReset(); });

  it('onMailMutation delegates to emitGtdIfRelevant with the mutation context', async () => {
    emitGtdIfRelevant.mockResolvedValueOnce(undefined);
    const mgr = {};
    await onMailMutation({ imapManager: mgr, accountId: 'a1', userId: 'u1', messageIds: ['<m1>'], actedFolders: ['INBOX'] });
    expect(emitGtdIfRelevant).toHaveBeenCalledWith(mgr, 'a1', 'u1', ['<m1>'], ['INBOX']);
  });

  it('onSentMessage delegates to runTransitionsForSentMessage', async () => {
    runTransitionsForSentMessage.mockResolvedValueOnce(undefined);
    const mgr = {};
    const account = { id: 'a1', gtd_enabled: true };
    await onSentMessage({ imapManager: mgr, account, messageId: '<abc@x>' });
    expect(runTransitionsForSentMessage).toHaveBeenCalledWith(mgr, account, '<abc@x>');
  });

  it('onUserDelete removes the user\'s legacy pet row by derived slug', async () => {
    customPetSlug.mockReturnValueOnce('pet-user-1');
    query.mockResolvedValueOnce({ rowCount: 1 });
    await onUserDelete({ userId: 'user-1' });
    expect(customPetSlug).toHaveBeenCalledWith('user-1');
    expect(query).toHaveBeenCalledWith('DELETE FROM gtd_pets WHERE slug = $1', ['pet-user-1']);
  });

  it('onUserDelete is a no-op when no slug derives and swallows a cleanup failure', async () => {
    customPetSlug.mockReturnValueOnce(null);
    await onUserDelete({ userId: 'user-2' });
    expect(query).not.toHaveBeenCalled();

    customPetSlug.mockReturnValueOnce('pet-user-3');
    query.mockRejectedValueOnce(new Error('db boom'));
    await expect(onUserDelete({ userId: 'user-3' })).resolves.toBeUndefined();
  });
});

describe('gtd hooks — account settings (validateAccountSettings / onAccountSettingsChanged / onAccountIdentityChanged)', () => {
  beforeEach(() => {
    sanitizeGtdFoldersDetailed.mockReset(); findGtdFolderCollisions.mockReset();
    invalidateGtdConfigCache.mockReset(); invalidateOwnerAddressesCache.mockReset();
  });

  it('contributes nothing when neither gtd field is being updated', () => {
    expect(validateAccountSettings({ updates: { color: '#fff' }, existing: {} })).toBeUndefined();
    expect(sanitizeGtdFoldersDetailed).not.toHaveBeenCalled();
  });

  it('flags a reconnect for a gtd_enabled toggle even without a folder change', () => {
    const out = validateAccountSettings({ updates: { gtd_enabled: true }, existing: {} });
    expect(out).toEqual({ requiresReconnect: true });
    expect(sanitizeGtdFoldersDetailed).not.toHaveBeenCalled();
  });

  it('hard-rejects a state mapped to a reserved system folder', () => {
    sanitizeGtdFoldersDetailed.mockReturnValueOnce({ folders: {}, rejected: [], reserved: ['INBOX'] });
    const out = validateAccountSettings({ updates: { gtd_folders: { todo: 'INBOX' } }, existing: {} });
    expect(out.error.status).toBe(400);
    expect(out.error.body.reserved).toEqual(['INBOX']);
  });

  it('hard-rejects a folder collision', () => {
    sanitizeGtdFoldersDetailed.mockReturnValueOnce({ folders: { todo: 'X', watch: 'X' }, rejected: [], reserved: [] });
    findGtdFolderCollisions.mockReturnValueOnce(['X']);
    const out = validateAccountSettings({ updates: { gtd_folders: { todo: 'X', watch: 'X' } }, existing: {} });
    expect(out.error.status).toBe(400);
    expect(out.error.body.collisions).toEqual(['X']);
  });

  it('patches the sanitized folders, reports rejections, and reconnects on a real change', () => {
    // existing folders differ from the new ones → requiresReconnect
    sanitizeGtdFoldersDetailed
      .mockReturnValueOnce({ folders: { todo: 'Tasks' }, rejected: ['bad/../path'], reserved: [] }) // new
      .mockReturnValueOnce({ folders: { todo: 'Todo' } });                                            // existing
    findGtdFolderCollisions.mockReturnValueOnce([]);
    const out = validateAccountSettings({ updates: { gtd_folders: { todo: 'Tasks' } }, existing: { gtd_folders: {} } });
    expect(out.patch).toEqual({ gtd_folders: { todo: 'Tasks' } });
    expect(out.rejected).toEqual({ gtd_folders: ['bad/../path'] });
    expect(out.requiresReconnect).toBe(true);
  });

  it('does not require a reconnect when the sanitized folders are unchanged', () => {
    sanitizeGtdFoldersDetailed
      .mockReturnValueOnce({ folders: { todo: 'Todo' }, rejected: [], reserved: [] }) // new
      .mockReturnValueOnce({ folders: { todo: 'Todo' } });                            // existing
    findGtdFolderCollisions.mockReturnValueOnce([]);
    const out = validateAccountSettings({ updates: { gtd_folders: { todo: 'Todo' } }, existing: { gtd_folders: {} } });
    expect(out.requiresReconnect).toBe(false);
  });

  it('onAccountSettingsChanged invalidates the config cache only for gtd fields', async () => {
    await onAccountSettingsChanged({ accountId: 'a1', updates: { color: '#fff' } });
    expect(invalidateGtdConfigCache).not.toHaveBeenCalled();
    await onAccountSettingsChanged({ accountId: 'a1', updates: { gtd_enabled: true } });
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a1');
  });

  it('onAccountIdentityChanged invalidates the owner-address cache', async () => {
    await onAccountIdentityChanged({ accountId: 'a1' });
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith('a1');
  });
});
