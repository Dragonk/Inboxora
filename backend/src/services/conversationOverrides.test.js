import { describe, expect, it, vi } from 'vitest';
import { applyConversationOverride, validateOverrideType } from './conversationOverrides.js';

const { withTransaction, query } = vi.hoisted(() => ({ withTransaction: vi.fn(), query: vi.fn() }));
vi.mock('./db.js', () => ({ withTransaction, query }));

describe('conversation overrides', () => {
  it('rejects unknown override types', () => {
    expect(() => validateOverrideType('auto-merge')).toThrow('Unsupported conversation override type');
  });

  it('supports manual merge through the transactional service', async () => {
    withTransaction.mockImplementation(async fn => fn({ query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'c1', manually_locked: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c2', manually_locked: false }] })
      .mockResolvedValue({ rows: [], rowCount: 1 }) }));
    await expect(applyConversationOverride({ userId: 'u1', conversationId: 'c1', overrideType: 'manual-merge', targetId: 'c2' })).resolves.toMatchObject({ targetId: 'c2' });
  });
});
