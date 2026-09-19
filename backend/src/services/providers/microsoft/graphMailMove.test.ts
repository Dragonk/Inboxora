// The single implementation behind every Microsoft Graph move — the bulk routes,
// spam/ham, and both halves of snooze. The rule it owns is that a Graph move
// re-identifies the message, so the local row must adopt the id the provider returns
// rather than being left keyed to one that no longer exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  runProviderMutation: vi.fn(),
  graphFolderIdForPath: vi.fn(),
}));

vi.mock('../../db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../../providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('./graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graphMailSync.js')>();
  return { ...actual, graphFolderIdForPath: mocks.graphFolderIdForPath };
});

import { moveGraphMessageToFolder } from './graphMailMove.js';
import { providerUidForGraphMessage } from './graphMail.js';

const input = {
  userId: 'user-1',
  accountId: 'account-1',
  connectionId: 'connection-1',
  resourceId: 'message-1',
  providerMessageId: 'AAMkAD-1',
  destinationPath: 'Snoozed',
};

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.runProviderMutation.mockReset();
  mocks.graphFolderIdForPath.mockReset().mockResolvedValue('graph-snoozed');
});

describe('moving one Graph message onto a local folder', () => {
  it('adopts the identity the provider returned and re-homes the row', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2' }, replayed: false });

    const result = await moveGraphMessageToFolder(input);

    const expectedUid = providerUidForGraphMessage('AAMkAD-2');
    expect(result).toEqual({ moved: true, newProviderMessageId: 'AAMkAD-2', newUid: expectedUid });
    // A stale row at the destination holding the same derived number is removed first.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('uid = $2 AND folder = $3 AND id != $4'))).toBe(true);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).includes('provider_message_id = $3'));
    expect(update?.[1]).toEqual(['Snoozed', expectedUid, 'AAMkAD-2', 'message-1']);
  });

  it('refuses a destination the account never discovered, without calling the provider', async () => {
    mocks.graphFolderIdForPath.mockResolvedValue(null);
    await expect(moveGraphMessageToFolder(input)).resolves.toEqual({ moved: false, code: 'RESOURCE_NOT_FOUND' });
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });

  it('reports the provider code when the move is not confirmed, and does not re-home', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'outcome_unknown', operationId: 'op-1', code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false });

    await expect(moveGraphMessageToFolder(input)).resolves.toEqual({ moved: false, code: 'MUTATION_OUTCOME_UNKNOWN' });
    // The row stays where the user can still see it.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('provider_message_id = $3'))).toBe(false);
  });

  it('does not claim a move the provider answered without an identity', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: {}, replayed: false });
    await expect(moveGraphMessageToFolder(input)).resolves.toEqual({ moved: false });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('provider_message_id = $3'))).toBe(false);
  });

  it('asks the provider to move to the folder id the local path resolves to', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2' }, replayed: false });
    await moveGraphMessageToFolder(input);
    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', destinationFolderId: 'graph-snoozed' });
    expect(request.resourceId).toBe('message-1');
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: false });
  });
});
