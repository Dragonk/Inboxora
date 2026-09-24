import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const operations = vi.hoisted(() => ({ beginOperation: vi.fn(), completeOperation: vi.fn(), recordOperationProgress: vi.fn(), scheduleOperationRetry: vi.fn() }));
vi.mock('./providerOperations.js', () => operations);
vi.mock('./db.js', () => ({ withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}) }));
import { runProviderMutation, type ProviderMutationAdapter } from './providerMutationService.js';

beforeEach(() => {
  for (const fn of Object.values(operations)) fn.mockReset();
  operations.beginOperation.mockResolvedValue({ outcome: 'started', operationId: 'operation', claimToken: 'token', generation: 1, reclaimed: false, progress: [] });
  operations.completeOperation.mockResolvedValue(true);
  operations.scheduleOperationRetry.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());
const request = { userId: 'user', channel: 'web' as const, operation: 'create' as const, payload: {} };

describe('durable provider backoff orchestration', () => {
  it.each([
    { configured: 3.1, provider: 10.2, expected: 11 },
    { configured: 10, provider: 2, expected: 10 },
    { configured: -1, provider: Infinity, expected: 0 },
    { configured: NaN, provider: 2.3, expected: 3 },
    { configured: undefined, provider: undefined, expected: 0 },
  ])('honors the larger validated configured/provider delay: $expected seconds', async ({ configured, provider, expected }) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const adapter: ProviderMutationAdapter<object> = { resourceType: 'calendar_collection', idempotent: false, perform: async () => ({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: provider }) };
    const result = await runProviderMutation({ ...request, ...(configured !== undefined ? { retry: { delaySeconds: configured } } : {}) }, adapter);
    expect(result).toMatchObject({ status: 'retryable', retryAfterSeconds: expected });
    expect(operations.scheduleOperationRetry).toHaveBeenCalledWith({}, expect.objectContaining({ nextAttemptAt: new Date(1_000_000 + expected * 1000), claimToken: 'token', generation: 1 }));
  });
  it('returns pending backoff without dispatching an early retry', async () => {
    operations.beginOperation.mockResolvedValue({ outcome: 'in_progress', operationId: 'operation', status: 'pending', retryAfterSeconds: 15 });
    const perform = vi.fn();
    expect(await runProviderMutation(request, { resourceType: 'calendar_collection', idempotent: false, perform })).toEqual({ status: 'pending', operationId: 'operation', replayed: true, retryAfterSeconds: 15 });
    expect(perform).not.toHaveBeenCalled(); expect(operations.scheduleOperationRetry).not.toHaveBeenCalled();
  });
  it('does not report retryable when the claim cannot durably schedule it', async () => {
    operations.scheduleOperationRetry.mockResolvedValue(false);
    const result = await runProviderMutation(request, { resourceType: 'calendar_collection', idempotent: false, perform: async () => ({ status: 'retryable', retryAfterSeconds: 10 }) });
    expect(result.status).toBe('outcome_unknown');
  });
});
