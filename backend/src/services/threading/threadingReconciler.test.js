import { describe, expect, it, vi } from 'vitest';
import { auditThreading, rebuildThreading } from './threadingReconciler.js';

vi.mock('../db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async fn => fn({ query: vi.fn().mockResolvedValue({ rowCount: 1 }) })),
}));

import { query } from '../db.js';

describe('threading reconciler', () => {
  it('reports non-canonical ids without mutating in dry-run mode', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', account_id: 'a1', message_id: 'root@x', thread_id: 'root@x' }] });
    const result = await auditThreading({ limit: 10 });
    expect(result.findings.map(f => f.type)).toEqual(['non_canonical_message_id', 'non_canonical_thread_id']);
  });

  it('rebuilds only findings and preserves dry-run as the default', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', account_id: 'a1', message_id: 'root@x', thread_id: null }] });
    const dry = await rebuildThreading({});
    expect(dry.dryRun).toBe(true);
    expect(dry.updated).toBe(0);
  });
});
