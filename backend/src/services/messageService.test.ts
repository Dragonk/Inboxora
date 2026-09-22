import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = vi.mocked(await import('./db.js'));
import { listMessages } from './messageService.js';

beforeEach(() => {
  query.mockClear();
});

describe('listMessages — draft identity projections', () => {
  it('returns canonical UIDVALIDITY text and private draft BCC in flat and threaded rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'draft-1', draft_uid_validity: '42', draft_bcc_addresses: [{ email: 'hidden@example.test' }] }] });
    const flat = await listMessages({ userId: 'user-1', threaded: false });
    expect(flat.messages[0]).toMatchObject({ draft_uid_validity: '42', draft_bcc_addresses: [{ email: 'hidden@example.test' }] });
    expect(String(query.mock.calls[2][0])).toContain('m.draft_uid_validity::text AS draft_uid_validity');
    expect(String(query.mock.calls[2][0])).toContain('m.draft_bcc_addresses');
    expect(String(query.mock.calls[2][0])).toContain('m.draft_alias_id, m.draft_in_reply_to, m.draft_references, m.draft_composition');

    query.mockReset()
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'draft-1', draft_uid_validity: '42', draft_bcc_addresses: [{ email: 'hidden@example.test' }] }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    await listMessages({ userId: 'user-1', threaded: true });
    const threadedSql = String(query.mock.calls[2][0]);
    expect(threadedSql).toContain('m.draft_uid_validity::text AS draft_uid_validity');
    expect(threadedSql).toContain('draft_bcc_addresses, draft_uid_validity, draft_alias_id, draft_in_reply_to');
  });
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
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })                  // membership-aware count
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', folder: 'INBOX' }] }); // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-other' });

    // Unified inbox returns the cached total from the folder sum query
    expect(result.total).toBe(5);
    expect(result.resolvedAccountId).toBeNull();

    // The folder count query should have used total_count (not unread_count)
    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('COUNT(*)');
    expect(countSql).toContain('message_labels');
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

    const messageQuery = query.mock.calls[2];
    if (!messageQuery) {
      throw new Error('Expected the messages query to be called');
    }

    const messageParameters = messageQuery[1];
    if (!messageParameters) {
      throw new Error('Expected the messages query to receive parameters');
    }

    expect(messageParameters[0]).toEqual(['acc-included']);
  });

  it('keeps an opted-out account available in its direct account view', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'acc-excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
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
      .mockResolvedValueOnce({ rows: [{ n: 7 }] })                          // membership-aware count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1', unreadOnly: true });

    expect(result.total).toBe(7);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('COUNT(*)');
    expect(countSql).toContain('is_read = false');
  });

  it('sums total_count across accounts for unified inbox when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 42 }] })                         // membership-aware count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1' });

    expect(result.total).toBe(42);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('COUNT(*)');
    expect(countSql).toContain('message_labels');
  });

  it('reads unread_count from folder row for specific account when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', unreadOnly: true });

    expect(result.total).toBe(3);
    expect(result.resolvedAccountId).toBe('acc-1');
  });

  it('counts the same membership-aware set for a specific account', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(result.total).toBe(3);
  });
});

// Threaded mode: 4 query calls — accounts, folder cache, thread CTE, thread count
describe('listMessages — threaded mode', () => {
  it('returns thread count as total, ignoring the cached folder count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })  // membership-aware count
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] })                       // thread CTE
      .mockResolvedValueOnce({ rows: [{ total: 5 }] });                          // thread count

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: true });

    expect(result.total).toBe(5);
    expect(result.threaded).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it('counts thread messages across ALL folders when viewing a specific account INBOX (badge === expansion)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: true });

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
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: true });

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

    await listMessages({ userId: 'user-1', threaded: true });

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

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: true });

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

    await listMessages({ userId: 'user-1', threaded: true });

    const cteSql = query.mock.calls[2][0];
    const countSql = query.mock.calls[3][0];
    expect(cteSql).toContain("m.account_id::text || ':' || m.thread_key");
    expect(cteSql).toContain('m.thread_key,');
    expect(cteSql).toContain('PARTITION BY d.thread_id');
    expect(countSql).toContain('GROUP BY m.account_id, m.thread_key');
    expect(cteSql).toContain('pt.account_id = m.account_id AND pt.thread_key = m.thread_key');
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

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: true });

    expect(query.mock.calls[2][0]).toContain('delivery_addresses');
  });

  it('selects spam verdict fields in the flat query so SpamBadge receives data', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(query.mock.calls[2][0]).toContain('m.spam_verdict');
    expect(query.mock.calls[2][0]).toContain('m.spam_score_ml');
  });

  it('selects spam verdict fields in the threaded query too', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: true });

    const threadedSql = String(query.mock.calls[2][0]);
    // The verdict must survive to the FINAL projection from `ranked` — a
    // field present only inside the `deduped` CTE never reaches the parent
    // row the reader renders.
    const finalSelect = threadedSql.slice(threadedSql.lastIndexOf('FROM ranked'));
    const projection = threadedSql.slice(threadedSql.indexOf('SELECT id, uid, folder'), threadedSql.indexOf('FROM ranked'));
    expect(projection).toContain('spam_verdict');
    expect(projection).toContain('spam_score_ml');
    expect(finalSelect).toContain('rn = 1');
  });
});

describe('listMessages — ghost row suppression (#407)', () => {
  it('excludes hollow UID-only placeholder rows in the flat query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    const sql = query.mock.calls[2][0];
    expect(sql).toContain('NOT (m.message_id IS NULL');
    expect(sql).toContain("m.subject = '(no subject)'");
  });

  it('excludes hollow placeholder rows in the threaded query too (consistent pagination)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: true });

    // CTE (call 2) and thread-count (call 3) both share `where`, so both exclude ghosts.
    expect(query.mock.calls[2][0]).toContain('NOT (m.message_id IS NULL');
    expect(query.mock.calls[3][0]).toContain('NOT (m.message_id IS NULL');
  });
});
