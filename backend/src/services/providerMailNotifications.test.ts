// New-mail notification emission for the native-transport syncs, asserted at
// the helper both provider syncs call: unread INBOX rows in, one canonical
// event out (alert count, badge count), and a delta of nothing alert-worthy
// emits nothing at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), dispatch: vi.fn() }));

vi.mock('./db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('./pushDispatcher.js', () => ({ dispatchMailNotification: mocks.dispatch }));

import { dispatchProviderMailNotifications, scheduleProviderMailNotifications } from './providerMailNotifications.js';

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    account_id: 'account-1',
    from_name: 'Alice Example',
    from_email: 'alice@example.test',
    subject: 'Quarterly plan',
    ...overrides,
});

beforeEach(() => {
    mocks.query.mockReset();
    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue({ dispatched: true });
});

describe('provider new-mail notifications', () => {
    it('emits one canonical event for the unread INBOX rows of a delta', async () => {
        mocks.query
            .mockResolvedValueOnce({ rows: [row('m2'), row('m1', { from_name: null, from_email: 'bob@example.test' })] })
            .mockResolvedValueOnce({ rows: [{ total: 7 }] });

        const alerted = await dispatchProviderMailNotifications({ userId: 'user-1', rowIds: ['m1', 'm2'] });

        expect(alerted).toBe(2);
        expect(mocks.dispatch).toHaveBeenCalledTimes(1);
        const event = mocks.dispatch.mock.calls[0][0] as {
            userId: string; alertCount: number; accountId: string;
            webPush: { title: string; body: string; unreadCount: number };
            native: { type: string; eventId: string };
        };
        expect(event.userId).toBe('user-1');
        expect(event.alertCount).toBe(2);
        expect(event.native).toEqual({ type: 'mail.changed', eventId: 'm2' });
        expect(event.webPush.unreadCount).toBe(7);
        // The latest row of the delta titles the notification.
        expect(event.webPush.title).toBe('Alice Example');
    });

    it('emits nothing when no row is an unread INBOX message', async () => {
        mocks.query.mockResolvedValueOnce({ rows: [] });

        const alerted = await dispatchProviderMailNotifications({ userId: 'user-1', rowIds: ['m1'] });

        expect(alerted).toBe(0);
        expect(mocks.dispatch).not.toHaveBeenCalled();
        // The unread count is never queried when there is nothing to alert on.
        expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it('still notifies when the unread-count query fails', async () => {
        mocks.query
            .mockResolvedValueOnce({ rows: [row('m1')] })
            .mockRejectedValueOnce(new Error('count unavailable'));

        const alerted = await dispatchProviderMailNotifications({ userId: 'user-1', rowIds: ['m1'] });

        expect(alerted).toBe(1);
        expect(mocks.dispatch).toHaveBeenCalledTimes(1);
        const event = mocks.dispatch.mock.calls[0][0] as { webPush: Record<string, unknown> };
        expect(event.webPush).not.toHaveProperty('unreadCount');
    });

    it('schedules fire-and-forget: an empty delta never touches the database, a failure never throws', async () => {
        scheduleProviderMailNotifications({ userId: 'user-1', rowIds: [] });
        expect(mocks.query).not.toHaveBeenCalled();

        mocks.query.mockResolvedValue({ rows: [] });
        scheduleProviderMailNotifications({ userId: 'user-1', rowIds: ['m1'] });
        await new Promise(resolve => setImmediate(resolve));
        expect(mocks.dispatch).not.toHaveBeenCalled();

        mocks.query.mockReset();
        mocks.query.mockRejectedValue(new Error('database gone'));
        scheduleProviderMailNotifications({ userId: 'user-1', rowIds: ['m1'] });
        await new Promise(resolve => setImmediate(resolve));
    });
});
