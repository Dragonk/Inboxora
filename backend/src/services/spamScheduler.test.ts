import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./spamModelStore.js', () => ({
  retrainUser: vi.fn(),
  getAllUsersWithTrainingLog: vi.fn(),
}));

import { offsetHoursForUser, isRunning, runBucket, runFullRetrain, start, stop } from './spamScheduler.js';
import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';

const mockedRetrainUser = vi.mocked(retrainUser);
const mockedGetAll = vi.mocked(getAllUsersWithTrainingLog);

beforeEach(() => {
  vi.mocked(retrainUser).mockReset().mockResolvedValue({ ok: true, recordsUsed: 1, duration_ms: 1 });
  vi.mocked(getAllUsersWithTrainingLog).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  stop();
});

describe('spam scheduler', () => {
  it('distributes users uniformly across 24 buckets', () => {
    const offsets = new Set(
      Array.from({ length: 200 }, (_, i) =>
        offsetHoursForUser(`${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`)),
    );
    expect(offsets.size).toBeGreaterThan(15);
  });

  it('refuses a second run while one is in flight', async () => {
    let release!: (users: string[]) => void;
    const gate = new Promise<string[]>(resolve => { release = resolve; });
    mockedGetAll.mockReturnValue(gate);
    const first = runBucket(0);
    expect(isRunning()).toBe(true);
    const second = await runFullRetrain();
    expect(second.accepted).toBe(false);
    release([]);
    const firstSummary = await first;
    expect(firstSummary.usersProcessed).toBe(0);
    expect(isRunning()).toBe(false);
  });

  it('retrains only the matching bucket', async () => {
    const users = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    mockedGetAll.mockResolvedValue(users);
    const hour = offsetHoursForUser(users[0] ?? '');
    const summary = await runBucket(hour);
    const expected = users.filter(u => offsetHoursForUser(u) === hour).length;
    expect(mockedRetrainUser).toHaveBeenCalledTimes(expected);
    expect(summary.usersProcessed).toBe(expected);
  });

  it('self-schedules after boot without overlapping', () => {
    start();
    expect(isRunning()).toBe(false);
    stop();
  });
});
