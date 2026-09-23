import { describe, expect, it, vi } from 'vitest';
import { repairOrphanedRepliesWithClient, replyParentHeaders } from './orphanedReplyRepair.js';

describe('replyParentHeaders', () => {
  it('uses a unique In-Reply-To first, otherwise the newest References id', () => {
    expect(replyParentHeaders({ in_reply_to: '<b>', thread_references: '<a> <b>' })).toEqual(['<b>']);
    expect(replyParentHeaders({ in_reply_to: null, thread_references: '<a> <b>' })).toEqual(['<b>']);
    expect(replyParentHeaders({ in_reply_to: 'not-an-id', thread_references: null })).toEqual([]);
  });
});

describe('repairOrphanedRepliesWithClient', () => {
  it('repairs only one unambiguous same-account RFC edge and rolls dry-run writes back', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT m.*, EXISTS') && sql.includes('FROM messages m')) return { rows: [
        { id: 'child', account_id: 'account', in_reply_to: '<parent>', thread_references: '<root> <parent>', conversation_id: 'old', logical_message_id: 'logical-child', manual_protected: false },
      ] };
      if (sql.includes('m.message_id = $2')) return { rows: [
        { id: 'parent', account_id: 'account', message_id: '<parent>', conversation_id: 'target', logical_message_id: 'logical-parent', manual_protected: false },
      ] };
      if (sql.startsWith('SELECT conversation_id')) return { rows: [
        { conversation_id: 'target', logical_message_id: 'logical-child' },
      ] };
      return { rows: [] };
    });
    const apply = vi.fn(async () => undefined);
    const counters = await repairOrphanedRepliesWithClient({ query } as never, { userId: 'user', dryRun: true }, apply);

    expect(counters).toEqual({ scanned: 1, repaired: 1, ambiguous: 0, missing_parent: 0, protected_by_manual_override: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SAVEPOINT orphaned_reply_repair_dry_run');
    expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT orphaned_reply_repair_dry_run');
  });

  it('never applies a candidate protected by a manual override', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT m.*, EXISTS')
      ? { rows: [{ id: 'child', account_id: 'account', in_reply_to: '<parent>', manual_protected: true }] }
      : { rows: [] });
    const apply = vi.fn();
    const counters = await repairOrphanedRepliesWithClient({ query } as never, { userId: 'user' }, apply);

    expect(counters).toEqual({ scanned: 1, repaired: 0, ambiguous: 0, missing_parent: 0, protected_by_manual_override: 1 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('counts duplicate parent Message-IDs as ambiguous and writes nothing', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('m.message_id = $2')) return { rows: [{ id: 'parent-a' }, { id: 'parent-b' }] };
      if (sql.startsWith('SELECT m.*, EXISTS')) return { rows: [{ id: 'child', account_id: 'account', in_reply_to: '<parent>', manual_protected: false }] };
      return { rows: [] };
    });
    const apply = vi.fn();
    const counters = await repairOrphanedRepliesWithClient({ query } as never, { userId: 'user', dryRun: false }, apply);

    expect(counters).toEqual({ scanned: 1, repaired: 0, ambiguous: 1, missing_parent: 0, protected_by_manual_override: 0 });
    expect(apply).not.toHaveBeenCalled();
  });
});
