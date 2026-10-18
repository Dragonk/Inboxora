// A provider-confirmed 404 on a flag write means the message is gone from the
// mailbox. The flag worker used to record the failure and leave the ghost row
// unread forever; it must enqueue the same tombstone the folder delta uses so
// the durable reconciliation can delete the row.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    client: { query: vi.fn() },
    enqueueGhost: vi.fn(),
}));

vi.mock('node:crypto', () => ({ randomUUID: () => 'token-1' }));
vi.mock('./db.js', () => ({
    query: mocks.query,
    withTransaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run(mocks.client)),
}));
vi.mock('./providers/microsoft/graphPendingMessageRemovals.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./providers/microsoft/graphPendingMessageRemovals.js')>()),
    enqueueGraphGhostRemoval: mocks.enqueueGhost,
}));

import { processMailFlagIntent, type MailFlagPorts, type MailFlagOutcome } from './mailFlagState.js';
import type { ProviderAdapterOutcome } from './providerMutationService.js';

const identity = {
    accountId: 'account-1',
    userId: 'user-1',
    transport: 'microsoft_graph',
    transportGeneration: '1',
    connection: 'connection-1',
    providerId: 'AAMkAD-1',
    uid: '4',
    folder: 'INBOX',
    uidValidity: '7',
};

const claim = {
    message_id: 'message-1',
    account_id: 'account-1',
    user_id: 'user-1',
    flag: '\\Seen',
    value: true,
    generation: 'generation-1',
    identity,
    status: 'pending',
    lease_token: null,
};

const state = {
    id: 'message-1',
    account_id: 'account-1',
    user_id: 'user-1',
    identity,
    is_read: false,
    is_starred: false,
    is_deleted: false,
    account_enabled: true,
    connection_status: 'active',
    read_changed_at: null,
    star_changed_at: null,
};

beforeEach(() => {
    mocks.query.mockReset();
    mocks.client.query.mockReset();
    mocks.enqueueGhost.mockReset();
    mocks.enqueueGhost.mockResolvedValue(true);
    // claim -> state -> account -> writing-claim transition
    mocks.query
        .mockResolvedValueOnce({ rows: [claim], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [state], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'account-1', user_id: 'user-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });
    // inside the transaction: re-read state, re-check intent ownership
    mocks.client.query.mockImplementation(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes('FOR NO KEY UPDATE')) return { rows: [state], rowCount: 1 };
        return { rows: [{ ...claim, lease_token: 'token-1', lease_valid: true }], rowCount: 1 };
    });
});

const run = async (write: ProviderAdapterOutcome<void>): Promise<MailFlagOutcome> => {
    const ports: MailFlagPorts = {
        manager: {} as never,
        write: vi.fn(async () => write),
    };
    return processMailFlagIntent('message-1', '\\Seen', ports);
};

describe('a Graph ghost message enqueues durable removal on a provider-confirmed 404', () => {
    it('records the tombstone when the flag write is answered with RESOURCE_NOT_FOUND', async () => {
        const outcome = await run({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });

        expect(outcome).toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
        expect(mocks.enqueueGhost).toHaveBeenCalledTimes(1);
        expect(mocks.enqueueGhost.mock.calls[0][1]).toEqual({
            connectionId: 'connection-1',
            accountId: 'account-1',
            providerMessageId: 'AAMkAD-1',
            folderPath: 'INBOX',
        });
    });

    it('does not enqueue for other permanent refusals', async () => {
        await run({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
        expect(mocks.enqueueGhost).not.toHaveBeenCalled();
    });

    it('does not enqueue a tombstone while the outcome is still unknown', async () => {
        await run({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
        expect(mocks.enqueueGhost).not.toHaveBeenCalled();
    });

    it('survives a failing enqueue without failing the intent processing', async () => {
        mocks.enqueueGhost.mockRejectedValue(new Error('link missing'));
        const outcome = await run({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
        expect(outcome).toEqual({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' });
    });
});
