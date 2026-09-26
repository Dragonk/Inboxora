// The single implementation behind every Microsoft Graph move — the bulk routes,
// spam/ham, and both halves of snooze. The rule it owns is that a Graph move
// re-identifies the message, so the local row must adopt the id the provider returns
// rather than being left keyed to one that no longer exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  projectMove: vi.fn(),
  runProviderMutation: vi.fn(),
  graphFolderIdForPath: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  query: mocks.query,
  withTransaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }),
}));
vi.mock('./graphMailContinuity.js', () => ({ projectGraphMove: mocks.projectMove }));
vi.mock('../../providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('./graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graphMailSync.js')>();
  return { ...actual, graphFolderIdForPath: mocks.graphFolderIdForPath };
});

import { deleteGraphMessagePermanently, moveGraphMessageToFolder } from './graphMailMove.js';
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
  mocks.projectMove.mockReset().mockResolvedValue({ moved: true, uid: providerUidForGraphMessage("AAMkAD-2") });
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
    expect(mocks.projectMove).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account-1', connectionId: 'connection-1', rowId: 'message-1',
      sourceId: 'AAMkAD-1', targetId: 'AAMkAD-2', targetPath: 'Snoozed',
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(false);
  });

  it('does not report success when the local canonical row was not projected', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', value: { id: 'AAMkAD-2' } });
    mocks.projectMove.mockResolvedValue({ moved: false, uid: null });
    await expect(moveGraphMessageToFolder(input)).resolves.toEqual({ moved: false, code: 'MUTATION_OUTCOME_UNKNOWN' });
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

describe('removing one Graph message for good', () => {
  const remove = {
    userId: 'user-1', accountId: 'account-1', connectionId: 'connection-1',
    resourceId: 'message-1', providerMessageId: 'AAMkAD-1',
  };

  it('reports the removal only when the provider confirmed it', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false });
    await expect(deleteGraphMessagePermanently(remove)).resolves.toEqual({ deleted: true });
    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.operation).toBe('delete');
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: false });
  });

  it('carries the provider code when it did not, so a caller can tell refusal from uncertainty', async () => {
    mocks.runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-1', code: 'RESOURCE_NOT_FOUND', replayed: false });
    await expect(deleteGraphMessagePermanently(remove)).resolves.toEqual({ deleted: false, code: 'RESOURCE_NOT_FOUND' });
    mocks.runProviderMutation.mockResolvedValue({ status: 'outcome_unknown', operationId: 'op-2', code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false });
    await expect(deleteGraphMessagePermanently(remove)).resolves.toEqual({ deleted: false, code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});
