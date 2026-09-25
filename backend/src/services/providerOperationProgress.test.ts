import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Durable progress for a multi-write operation (CAL-01).
 *
 * Splitting a repeating series is two provider writes — truncate the master, create the remainder — and a process
 * that dies between them used to leave the journal saying only that the operation had started, which a reclaimed
 * non-idempotent claim can only park as an unknown outcome. Each completed stage is now appended to the
 * operation's `upstream_ref`, under the same claim fence as the terminal write, with the data the next step needs.
 */

vi.mock('./db.js', () => ({ query: vi.fn() }));
const { query } = vi.mocked(await import('./db.js'));
import { recordOperationProgress } from './providerOperations.js';

const claim = { operationId: 'op-1', claimToken: 'claim-1', generation: 3 };

beforeEach(() => { vi.clearAllMocks(); });

describe('recording an operation’s stages', () => {
  it('appends the stage and its detail to the operation, fenced by the claim', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'op-1' }] } as never);

    const recorded = await recordOperationProgress({ query } as never, {
      ...claim, stage: 'master_truncated', detail: { masterId: 'series-1' },
    });

    expect(recorded).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Appended, not overwritten: a second stage must not erase the first.
    expect(sql).toContain("COALESCE(upstream_ref->'progress', '[]'::jsonb)");
    expect(sql).toContain('jsonb_build_array');
    // The claim token and generation fence the write exactly as the terminal one is fenced.
    expect(sql).toContain('WHERE id = $1 AND claim_token = $2 AND generation = $3');
    expect(params).toEqual(['op-1', 'claim-1', 3, 'master_truncated', JSON.stringify({ masterId: 'series-1' })]);
  });

  it('reports that it did not record when the claim is no longer ours', async () => {
    // A worker that lost its claim must not be able to append to an operation another worker now owns.
    query.mockResolvedValue({ rowCount: 0, rows: [] } as never);
    await expect(recordOperationProgress({ query } as never, { ...claim, stage: 'remainder_created' })).resolves.toBe(false);
  });
});
