import { describe, expect, it, vi } from 'vitest';
import { normalizeMessageId } from './normalizeMessageId.js';
import { findThreadParents, resolveThreadId } from './threadingRepository.js';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';

describe('threading repository', () => {
  it('looks up both canonical and legacy bare Message-ID storage', async () => {
    query.mockResolvedValueOnce({ rows: [{ message_id: 'parent@example', thread_id: '<root@example>' }] });
    const found = await findThreadParents('account-1', ['<parent@example>']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ANY($2::text[])'), [
      'account-1', ['<parent@example>', 'parent@example'],
    ]);
    expect(found.get('<parent@example>')).toBe('<root@example>');
  });

  it('normalizes ids before persistence resolution', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveThreadId({
      accountId: 'account-1',
      messageId: 'child@example',
      references: '<parent@example>',
      normalizeSubject: () => '',
    })).toBe('<parent@example>');
    expect(normalizeMessageId('child@example')).toBe('<child@example>');
  });
});
