import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Translating a mailbox's Graph message ids to the immutable form (GRAPH-04).
 *
 * Graph offers two kinds of id: the default, which can change when an item moves, and the immutable one. Switching
 * the synchronisation to the immutable form without translating what is already stored would make every stored id
 * unrecognisable — each message would look new and be duplicated, and the existing rows would be orphaned. The
 * translation is therefore its own, dry-runnable step, and this pins what it does: it asks Graph for each stored
 * message's immutable id, plans the change, and writes only what the plan says.
 *
 * `graphGetWithHeaders` is the seam: the client owns the token and the request, so the preference is asserted where
 * it is passed rather than by stubbing the network under an authorization the test does not have.
 */

vi.mock('../../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./graphApiClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./graphApiClient.js')>()),
  graphGetWithHeaders: vi.fn(),
}));
const { query, withTransaction } = vi.mocked(await import('../../db.js'));
const { graphGetWithHeaders } = vi.mocked(await import('./graphApiClient.js'));
import {
  applyGraphMessageIdTranslation,
  immutableIdForMessage,
  immutableIdsEnabled,
  markMessageIdsTranslated,
  planGraphMessageIdTranslation,
} from './graphMessageIdType.js';

const api = { userId: 'user-1', connectionId: 'connection-1' };

beforeEach(() => { vi.clearAllMocks(); });

describe('asking Graph for a message’s immutable id', () => {
  it('asks with the preference and returns the id Graph answers with', async () => {
    graphGetWithHeaders.mockResolvedValue({ id: 'IMMUTABLE-1' });

    await expect(immutableIdForMessage(api, 'AAMkAD-1')).resolves.toBe('IMMUTABLE-1');

    const [options, path, headers] = graphGetWithHeaders.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(options).toMatchObject(api);
    expect(path).toContain('/me/messages/AAMkAD-1');
    // The preference is per request — it is what makes Graph answer with the immutable form.
    expect(String(headers.prefer)).toContain('ImmutableId');
  });

  it('answers null when Graph reports no id', async () => {
    graphGetWithHeaders.mockResolvedValue({});
    await expect(immutableIdForMessage(api, 'AAMkAD-1')).resolves.toBeNull();
  });
});

describe('planning and applying the translation', () => {
  it('plans a change only where the immutable id differs, and names what Graph would not answer for', async () => {
    query.mockResolvedValue({ rows: [
      { id: 'row-1', provider_message_id: 'AAMkAD-1', account_id: 'acc-1' },
      { id: 'row-2', provider_message_id: 'IMMUTABLE-2', account_id: 'acc-1' },
      { id: 'row-3', provider_message_id: 'AAMkAD-3', account_id: 'acc-1' },
    ] } as never);
    graphGetWithHeaders.mockImplementation(async (_options, path: string) => {
      if (path.includes('AAMkAD-1')) return { id: 'IMMUTABLE-1' };
      if (path.includes('IMMUTABLE-2')) return { id: 'IMMUTABLE-2' };
      throw new Error('Graph no longer holds this message');
    });

    const plan = await planGraphMessageIdTranslation(api);

    expect(plan.changes).toEqual([{ messageId: 'row-1', from: 'AAMkAD-1', to: 'IMMUTABLE-1' }]);
    expect(plan.unchanged).toBe(1);
    expect(plan.unavailable).toEqual([{ messageId: 'row-3', providerMessageId: 'AAMkAD-3' }]);
    // Planning writes nothing at all.
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('records the immutable id, and skips a row whose new id another row already holds', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 }) };
    withTransaction.mockImplementation((async (run: (value: unknown) => Promise<unknown>) => run(client)) as never);

    const result = await applyGraphMessageIdTranslation({
      changes: [
        { messageId: 'row-1', from: 'AAMkAD-1', to: 'IMMUTABLE-1' },
        { messageId: 'row-2', from: 'AAMkAD-2', to: 'IMMUTABLE-3' },
      ],
      unchanged: 0,
      unavailable: [],
    });

    expect(result).toEqual({ updated: 1, skipped: 1 });
    // The second row would have collided with an id another row of the same account already holds, so it is skipped
    // rather than allowed to break that identity.
    const [sql, params] = client.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('NOT EXISTS');
    expect(params).toEqual(['row-2', 'IMMUTABLE-3']);
  });
});

describe('the record that allows the immutable-id preference (GRAPH-04)', () => {
  it('records the translation only when every stored message was answered for', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'connection-1' }] } as never);

    // A message Graph would not answer for keeps its old id; asking for the immutable form afterwards would make
    // the synchronisation see a different id for it and insert a second copy. The record is therefore refused.
    const refused = await markMessageIdsTranslated({
      connectionId: 'connection-1',
      plan: { changes: [], unchanged: 3, unavailable: [{ messageId: 'row-1', providerMessageId: 'AAMkAD-1' }] },
    });
    expect(refused).toBe(false);
    expect(query).not.toHaveBeenCalled();

    const recorded = await markMessageIdsTranslated({
      connectionId: 'connection-1',
      plan: { changes: [{ messageId: 'row-1', from: 'AAMkAD-1', to: 'IMM-1' }], unchanged: 2, unavailable: [] },
    });
    expect(recorded).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('immutable_message_ids_at = NOW()');
    expect(params).toEqual(['connection-1']);
  });

  it('answers that the preference is not in use until that record exists', async () => {
    // The default state of every mailbox: the synchronisation keeps the default id form.
    query.mockResolvedValue({ rows: [{ immutable_message_ids_at: null }] } as never);
    await expect(immutableIdsEnabled('connection-1')).resolves.toBe(false);

    query.mockResolvedValue({ rows: [{ immutable_message_ids_at: new Date('2026-09-21T10:00:00Z') }] } as never);
    await expect(immutableIdsEnabled('connection-1')).resolves.toBe(true);
  });
});
