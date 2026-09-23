import { describe, expect, it, vi } from 'vitest';
import { repairExistingGraphLegacyMessageBindings } from './graphLegacyMessageBindingRepair.js';

describe('repairExistingGraphLegacyMessageBindings', () => {
  it('binds an existing local legacy/native pair in a bounded, resumable pass', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-0000-0000-000000000010', message_id: '<x@test>', from_email: 'a@test', date: new Date('2026-09-23T10:00:00Z') }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-0000-0000-000000000020', provider_message_id: 'graph-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: '00000000-0000-0000-0000-000000000010' }] })
      .mockResolvedValueOnce({ rows: [{ legacy_message_id: '00000000-0000-0000-0000-000000000010' }] });
    const result = await repairExistingGraphLegacyMessageBindings({ query } as never, {
      userId: 'user-1', accountId: 'account-1', connectionId: 'connection-1', limit: 1,
    });
    expect(result).toEqual({ bound: 1, needsReview: 0, missingNative: 0, failed: 0, checkpoint: '00000000-0000-0000-0000-000000000010' });
    expect(String(query.mock.calls[0]?.[0])).toContain('a.provider_connection_id = $3');
    expect(String(query.mock.calls[0]?.[0])).toContain('LIMIT $5');
  });

  it('records ambiguous native candidates for review and never chooses either provider id', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'legacy-1', message_id: '<x@test>', from_email: 'a@test', date: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ id: 'native-1', provider_message_id: 'graph-1' }, { id: 'native-2', provider_message_id: 'graph-2' }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await repairExistingGraphLegacyMessageBindings({ query } as never, {
      userId: 'user-1', accountId: 'account-1', connectionId: 'connection-1',
    });
    expect(result).toMatchObject({ bound: 0, needsReview: 1, missingNative: 0, failed: 0, checkpoint: 'legacy-1' });
    expect(String(query.mock.calls[2]?.[0])).toContain("'needs_review'");
  });
});
