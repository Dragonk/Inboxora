import { describe, it, expect, vi, beforeEach } from 'vitest';

// gtdSyncTick's config-fetch → per-folder fingerprint/sync → transitions/broadcast sequencing,
// tested against a mock manager instead of a live IMAP pool. The whole body is wrapped in a
// try/catch, so a config-fetch DB blip must be logged with account context and never escape as an
// unhandled rejection. getGtdConfig/gtdTickFolders run for real here (only db is mocked), so the
// enable + folder-set derivation is exercised end-to-end; unique account ids + cache invalidation
// keep the config cache from leaking across cases.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
// getGtdConfig folds in per-user plugin activation; the tick runs for real config here, so keep
// GTD activated (the tick's own gtd_enabled/folder logic is what these tests exercise).
vi.mock('../activation.js', () => ({ isPluginActivated: vi.fn().mockResolvedValue(true) }));
vi.mock('./gtdTransitions.js', () => ({
  runGtdTransitions: vi.fn(),
  threadKeysForMessageIds: vi.fn(),
  threadKeysInFolders: vi.fn(),
}));

import { query } from '../../services/db.js';
import { invalidateGtdConfigCache } from './gtdConfig.js';
import { runGtdTransitions, threadKeysInFolders } from './gtdTransitions.js';
import { gtdSyncTick } from './hooks.js';

describe('gtd hooks — gtdSyncTick', () => {
  const mgrWithConnection = (accountId, overrides = {}) => ({
    connections: new Map([[accountId, {}]]),
    onDemandSyncing: new Set(),
    folderFingerprint: vi.fn(),
    syncFolderViaPool: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    query.mockReset();
    runGtdTransitions.mockReset();
    threadKeysInFolders.mockReset();
    [
      'acct-tick-noconn', 'acct-tick-err', 'acct-tick-off',
      'acct-tick-same', 'acct-tick-changed', 'acct-tick-first', 'acct-tick-partial',
    ].forEach(invalidateGtdConfigCache);
  });

  it('skips entirely — no config read, no sync — when the account has no live connection', async () => {
    const mgr = { connections: new Map(), onDemandSyncing: new Set(), folderFingerprint: vi.fn(), syncFolderViaPool: vi.fn(), broadcast: vi.fn() };
    const account = { id: 'acct-tick-noconn', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(query).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('logs and swallows a config-fetch rejection instead of letting it escape as an unhandled rejection', async () => {
    query.mockRejectedValueOnce(new Error('db boom')); // getGtdConfig lookup throws
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = mgrWithConnection('acct-tick-err');
    const account = { id: 'acct-tick-err', user_id: 'user-1' };
    await expect(gtdSyncTick({ mgr, account })).resolves.toBeUndefined();
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GTD tick error'), 'db boom');
    warnSpy.mockRestore();
  });

  it('is inert — no folder sync, no broadcast — when GTD is disabled for the account', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
    const mgr = mgrWithConnection('acct-tick-off');
    const account = { id: 'acct-tick-off', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(mgr.syncFolderViaPool).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast or re-run transitions when the folder fingerprint is unchanged', async () => {
    const allTodo = { todo: 'Todo', watch: 'Todo', delegated: 'Todo', someday: 'Todo', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: allTodo }] });
    const mgr = mgrWithConnection('acct-tick-same', {
      folderFingerprint: vi.fn().mockResolvedValue('3:1:60:30'), // same before/after
    });
    const account = { id: 'acct-tick-same', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(mgr.syncFolderViaPool).toHaveBeenCalledWith(account, 'Todo');
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('broadcasts gtd_sections_updated and re-runs transitions when a folder fingerprint changes', async () => {
    const allTodo = { todo: 'Todo', watch: 'Todo', delegated: 'Todo', someday: 'Todo', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: allTodo }] });
    threadKeysInFolders.mockResolvedValueOnce(['thr-1', 'thr-2']);
    const mgr = mgrWithConnection('acct-tick-changed', {
      folderFingerprint: vi.fn()
        .mockResolvedValueOnce('3:1:60:30')  // before
        .mockResolvedValueOnce('4:1:90:40'), // after — changed
    });
    const account = { id: 'acct-tick-changed', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(threadKeysInFolders).toHaveBeenCalledWith('acct-tick-changed', ['Todo']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-1', 'thr-2']);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-tick-changed' }, 'user-1');
  });

  it('broadcasts gtd_sections_updated when an empty folder gains its first message', async () => {
    const allWatch = { todo: 'Watch', watch: 'Watch', delegated: 'Watch', someday: 'Watch', reference: 'Watch' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: allWatch }] });
    threadKeysInFolders.mockResolvedValueOnce(['thr-first']);
    const mgr = mgrWithConnection('acct-tick-first', {
      folderFingerprint: vi.fn()
        .mockResolvedValueOnce('0:0:0:0')
        .mockResolvedValueOnce('1:1:5:5'),
    });
    const account = { id: 'acct-tick-first', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-first']);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-tick-first' }, 'user-1');
  });

  it('keeps processing remaining folders when one folder sync throws', async () => {
    // todo/delegated/reference -> Todo, watch/someday -> Watch: two distinct designated folders.
    const twoFolders = { todo: 'Todo', watch: 'Watch', delegated: 'Todo', someday: 'Watch', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: twoFolders }] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = mgrWithConnection('acct-tick-partial', {
      folderFingerprint: vi.fn().mockResolvedValue('1:0:10:10'), // unchanged for the folder that completes
      syncFolderViaPool: vi.fn()
        .mockRejectedValueOnce(new Error('imap boom')) // first designated folder fails
        .mockResolvedValueOnce(undefined),              // second designated folder still runs
    });
    const account = { id: 'acct-tick-partial', user_id: 'user-1' };
    await gtdSyncTick({ mgr, account });
    expect(mgr.syncFolderViaPool).toHaveBeenCalledTimes(2);
    expect(mgr.syncFolderViaPool).toHaveBeenNthCalledWith(1, account, 'Todo');
    expect(mgr.syncFolderViaPool).toHaveBeenNthCalledWith(2, account, 'Watch');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GTD sync error'), 'imap boom');
    warnSpy.mockRestore();
  });
});
