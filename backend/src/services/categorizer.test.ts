import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  completeText: vi.fn<
    (...args: Parameters<typeof import('./aiProvider.js').completeText>) => Promise<unknown>
  >(),
}));

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => providerMocks);

import { query as __mock_query } from './db.js';
import { aiClassifyMessage } from './categorizer.js';

const query = vi.mocked(__mock_query);
const { completeText } = providerMocks;

beforeEach(() => {
  query.mockReset();
  completeText.mockReset();
});

describe('aiClassifyMessage provider adapter integration', () => {
  it.each(['primary', 'newsletter', 'promotion', 'automated', 'social'])(
    'accepts the exact supported category %s from completeText',
    async (category) => {
      completeText.mockResolvedValue(`  ${category.toUpperCase()}  `);
      await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
        .resolves.toBe(category);
      expect(completeText).toHaveBeenCalledWith([
        { role: 'user', content: expect.stringContaining('Subject: Subject') },
      ], { maxTokens: 1024 });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    'not-a-category',
    'This looks like a promotion',
    'primary or social',
    '',
    null,
  ])('rejects non-exact provider output %j', async (output) => {
    completeText.mockResolvedValue(output);
    await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
      .resolves.toBeNull();
  });

  it('returns null when the selected provider is unavailable or fails', async () => {
    completeText.mockRejectedValue(new Error('reconnect required'));
    await expect(aiClassifyMessage('Subject', 'sender@example.com', 'Preview'))
      .resolves.toBeNull();
  });

  it('never makes a provider-specific fetch outside the adapter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    completeText.mockResolvedValue('primary');
    await aiClassifyMessage('Subject', 'sender@example.com', 'Preview');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
