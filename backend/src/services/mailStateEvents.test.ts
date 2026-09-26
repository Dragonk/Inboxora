import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishMailStateChanged, subscribeMailStateChanges } from './mailStateEvents.js';

afterEach(() => vi.useRealTimers());
describe('mail-state invalidation (not an arrival notification)', () => {
  it('coalesces a burst for one owner and never broadcasts to another user', async () => {
    vi.useFakeTimers();
    const a = vi.fn(); const b = vi.fn();
    const stopA = subscribeMailStateChanges('a', a); const stopB = subscribeMailStateChanges('b', b);
    try {
      for (let i = 0; i < 100; i++) publishMailStateChanged({ userId: 'a', accountId: 'account', folders: ['INBOX'] });
      expect(a).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(a).toHaveBeenCalledExactlyOnceWith({ type: 'mail_state_changed', accountId: 'account', folders: ['INBOX'] });
      expect(b).not.toHaveBeenCalled();
    } finally { stopA(); stopB(); }
  });
  it('does not starve publication under a continuous stream', async () => {
    vi.useFakeTimers(); const seen = vi.fn(); const stop = subscribeMailStateChanges('stream', seen);
    try {
      for (let i = 0; i < 5; i++) {
        publishMailStateChanged({ userId: 'stream', accountId: 'account' });
        await vi.advanceTimersByTimeAsync(60);
      }
      expect(seen).toHaveBeenCalledOnce();
    } finally { stop(); }
  });
  it('lets an account-wide change dominate bounded folder hints', async () => {
    vi.useFakeTimers(); const seen = vi.fn(); const stop = subscribeMailStateChanges('scope', seen);
    try {
      publishMailStateChanged({ userId: 'scope', accountId: 'account', folders: ['INBOX'] });
      publishMailStateChanged({ userId: 'scope', accountId: 'account' });
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toHaveBeenCalledWith({ type: 'mail_state_changed', accountId: 'account', folders: null });
    } finally { stop(); }
  });
  it('cancels queued delivery after the last authenticated socket closes', async () => {
    vi.useFakeTimers(); const seen = vi.fn(); const stop = subscribeMailStateChanges('close', seen);
    publishMailStateChanged({ userId: 'close', accountId: 'account' }); stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).not.toHaveBeenCalled();
  });
  it('does not let a broken socket prevent another session receiving the hint', async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stopA = subscribeMailStateChanges('sessions', () => { throw new Error('closed'); });
    const seen = vi.fn(); const stopB = subscribeMailStateChanges('sessions', seen);
    try {
      publishMailStateChanged({ userId: 'sessions', accountId: 'account' });
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toHaveBeenCalledOnce();
    } finally { stopA(); stopB(); warn.mockRestore(); }
  });
});
