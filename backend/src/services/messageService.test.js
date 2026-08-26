import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
import { listMessages } from './messageService.js';

beforeEach(() => {
  query.mockClear();
});

describe('listMessages — account scope', () => {
  it('returns empty result immediately when user has no enabled accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await listMessages({ userId: 'user-1' });

    expect(result).toEqual({ messages: [], total: 0 });
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to unified inbox when accountId is not owned by the user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })           // accounts
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })                  // folder count
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', folder: 'INBOX' }] }); // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-other' });

    // Unified inbox returns the cached total from the folder sum query
    expect(result.total).toBe(5);
    expect(result.resolvedAccountId).toBeNull();

    // The folder count query should have used total_count (not unread_count)
    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });

  it('uses only opted-in accounts for the unified inbox', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'acc-included', include_in_unified_inbox: true },
          { id: 'acc-excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1' });

    expect(query.mock.calls[1][1]).toEqual([['acc-included']]);
    expect(query.mock.calls[2][1][0]).toEqual(['acc-included']);
  });

  it('keeps an opted-out account available in its direct account view', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'acc-excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [{ total_count: 2, unread_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] });

    const result = await listMessages({
      userId: 'user-1',
      accountId: 'acc-excluded',
    });

    expect(result.resolvedAccountId).toBe('acc-excluded');
    expect(query.mock.calls[1][1]).toEqual(['acc-excluded', 'INBOX']);
  });
});

describe('listMessages — total count selection', () => {
  it('sums unread_count across accounts for unified inbox when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 7 }] })                          // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1', unreadOnly: 'true' });

    expect(result.total).toBe(7);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('unread_count');
    expect(countSql).not.toContain('total_count');
  });

  it('sums total_count across accounts for unified inbox when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 42 }] })                         // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1' });

    expect(result.total).toBe(42);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });

  it('reads unread_count from folder row for specific account when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', unreadOnly: 'true' });

    expect(result.total).toBe(3);
    expect(result.resolvedAccountId).toBe('acc-1');
  });

  it('reads total_count from folder row for specific account when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(result.total).toBe(100);
  });
});

// Threaded mode: 4 query calls — accounts, folder cache, thread CTE, thread count
describe('listMessages — threaded mode', () => {
  it('returns thread count as total, ignoring the cached folder count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 99, unread_count: 2 }] })  // folder cache (not used)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] })                       // thread CTE
      .mockResolvedValueOnce({ rows: [{ total: 5 }] });                          // thread count

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(result.total).toBe(5);
    expect(result.threaded).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it('counts thread messages across ALL folders when viewing a specific account INBOX (badge === expansion)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    // P1-C: thread_totals must count across ALL folders (Inbox + Sent + Archive) so the
    // badge equals the number of unique children /mail/thread/:threadId expansion renders.
    // Scoping to INBOX produced badge=2 while expansion showed 3 (Inbox+Sent+Inbox).
    const cteSql = query.mock.calls[2][0];
    expect(cteSql).not.toContain('AND folder = $2');
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('counts thread messages across all folders when viewing a non-INBOX folder', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: 'true' });

    // thread_totals must not be scoped to a specific folder so the badge reflects true thread size
    const cteSql = query.mock.calls[2][0];
    expect(cteSql).not.toContain('AND folder = $2');
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('counts thread messages across ALL folders for unified inbox threaded view (badge === expansion)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 20 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    // P1-C: unified inbox thread_totals must also count across all folders so the
    // badge matches expansion. The old INBOX-only scope produced badge mismatches.
    const cteSql = query.mock.calls[2][0];
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('uses a physical fallback for NULL/empty Message-ID so badge count matches expansion children', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 3, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    // M1=<a>, M2=NULL, M3=<c> must produce badge=3: valid IDs dedupe by
    // normalized Message-ID; missing/whitespace IDs retain a deterministic physical row.
    expect(cteSql).toContain("COALESCE(NULLIF(btrim(m.message_id), ''), '__physical__:' || m.id::text)");
    expect(cteSql).toContain('COUNT(DISTINCT COALESCE(NULLIF(btrim(m.message_id), \'\'), \'__physical__:\' || m.id::text))::int AS message_count');
    expect(cteSql).not.toContain('m.message_id IS NOT NULL');
  });

  it('keeps equal legacy thread keys separate per account in unified threaded view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 2 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    const countSql = query.mock.calls[3][0];
    expect(cteSql).toContain("m.account_id::text || ':' || m.thread_key");
    expect(cteSql).toContain('m.thread_key,');
    expect(cteSql).toContain('PARTITION BY d.thread_id');
    expect(countSql).toContain("COUNT(DISTINCT (m.account_id::text || ':' || m.thread_key))");
  });
});

describe('listMessages — message shape', () => {
  it('preserves native thread identity in the flat message DTO', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    const sql = query.mock.calls[2][0];
    expect(sql).toContain('m.thread_id, m.thread_key');
    expect(sql).toContain('m.account_id');
  });

  it('selects delivery_addresses in the flat query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(query.mock.calls[2][0]).toContain('delivery_addresses');
  });

  it('selects delivery_addresses in the threaded query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(query.mock.calls[2][0]).toContain('delivery_addresses');
  });
});
