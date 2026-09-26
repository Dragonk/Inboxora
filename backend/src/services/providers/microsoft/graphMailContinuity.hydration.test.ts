// Unit tests for the HTTP hydration boundary. The continuity suite covers real SQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), graphGet: vi.fn() }));
vi.mock('../../db.js', () => ({ query: mocks.query, withSavepoint: vi.fn() }));
vi.mock('./graphApiClient.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./graphApiClient.js')>(),
  graphGet: mocks.graphGet,
}));

import { prepareGraphDeltaPage } from './graphMailContinuity.js';

const api = { userId: 'user-1', connectionId: 'connection-1' };
const page = {
  accountId: 'account-1', folderPath: 'INBOX', remoteFolderId: 'graph-inbox',
  messages: [{ id: 'message-1', isRead: false }],
};

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.graphGet.mockReset();
});

describe('hydrating sparse Graph message metadata', () => {
  it('accepts a hydrated item with intentionally empty display metadata', async () => {
    const snapshot = {
      id: 'message-1', parentFolderId: 'graph-inbox', internetMessageId: null,
      subject: '', bodyPreview: '', isRead: false, from: null, toRecipients: [],
    };
    mocks.graphGet.mockResolvedValue(snapshot);

    const prepared = await prepareGraphDeltaPage(api, page);
    expect(mocks.graphGet).toHaveBeenCalledTimes(1);
    expect(prepared.messages).toEqual([snapshot]);
    expect(prepared.checks.size).toBe(0);
  });

  it('still rejects a hydrated response without a physical identity or folder', async () => {
    for (const snapshot of [{ parentFolderId: 'graph-inbox' }, { id: 'message-1' }]) {
      mocks.graphGet.mockResolvedValue(snapshot);
      await expect(prepareGraphDeltaPage(api, page)).rejects.toThrow('Invalid Graph message snapshot');
    }
  });

  it('still rejects a response for a different physical message', async () => {
    mocks.graphGet.mockResolvedValue({ id: 'another-message', parentFolderId: 'graph-inbox' });
    await expect(prepareGraphDeltaPage(api, page)).rejects.toThrow('Graph snapshot has a different physical identity');
  });

  it('does not put a currently different-folder item into the source folder', async () => {
    mocks.graphGet.mockResolvedValue({ id: 'message-1', parentFolderId: 'graph-sent' });
    const prepared = await prepareGraphDeltaPage(api, page);
    expect(prepared.messages).toEqual([]);
  });
});
