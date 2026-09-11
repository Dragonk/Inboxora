import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendPushToUser, listActivePushDevices, disablePushDevice, markPushDeviceFailure, sendNativePush } = vi.hoisted(() => ({
  sendPushToUser: vi.fn(),
  listActivePushDevices: vi.fn(),
  disablePushDevice: vi.fn(),
  markPushDeviceFailure: vi.fn(),
  sendNativePush: vi.fn(),
}));

vi.mock('./pushNotifications.js', () => ({ pushConfigured: true, sendPushToUser }));
vi.mock('./pushDevices.js', () => ({ listActivePushDevices, disablePushDevice, markPushDeviceFailure }));
vi.mock('./pushTransports.js', () => ({
  sendNativePush,
  TRANSPORT_INVALID: 'invalid',
  TRANSPORT_RETRY: 'retry',
}));

import { dispatchMailNotification, resetDispatchDedup } from './pushDispatcher.js';

const event = (overrides = {}) => ({
  userId: 'user-1',
  eventId: 'msg-1',
  webPush: { title: 'Ada', body: 'Hello' },
  native: { type: 'mail.changed', eventId: 'msg-1' },
  ...overrides,
});

beforeEach(() => {
  resetDispatchDedup();
  sendPushToUser.mockReset().mockResolvedValue();
  listActivePushDevices.mockReset().mockResolvedValue([]);
  disablePushDevice.mockReset().mockResolvedValue();
  markPushDeviceFailure.mockReset().mockResolvedValue();
  sendNativePush.mockReset().mockResolvedValue('delivered');
});

describe('dispatchMailNotification', () => {
  it('fans one event out to Web Push and every native device', async () => {
    listActivePushDevices.mockResolvedValue([
      { id: 'row-1', transport: 'fcm', endpoint: 'token-1' },
      { id: 'row-2', transport: 'unifiedpush', endpoint: 'https://up.example/1' },
    ]);

    const summary = await dispatchMailNotification(event());

    expect(sendPushToUser).toHaveBeenCalledWith('user-1', { title: 'Ada', body: 'Hello' });
    expect(sendNativePush).toHaveBeenCalledTimes(2);
    expect(sendNativePush.mock.calls[0][1]).toEqual({ type: 'mail.changed', eventId: 'msg-1' });
    expect(summary).toEqual({ dispatched: true, webPush: 'delivered', native: { delivered: 2, invalid: 0, retry: 0, disabled: 0, skipped: null } });
  });

  it('disables only the permanently rejected device and keeps the rest', async () => {
    listActivePushDevices.mockResolvedValue([
      { id: 'row-old', transport: 'fcm', endpoint: 'expired' },
      { id: 'row-new', transport: 'fcm', endpoint: 'good' },
    ]);
    sendNativePush.mockImplementation(async (device) => (device.id === 'row-old' ? 'invalid' : 'delivered'));

    const summary = await dispatchMailNotification(event());

    expect(disablePushDevice).toHaveBeenCalledWith('row-old');
    expect(disablePushDevice).not.toHaveBeenCalledWith('row-new');
    expect(markPushDeviceFailure).not.toHaveBeenCalled();
    expect(summary.native).toEqual({ delivered: 1, invalid: 1, retry: 0, disabled: 0, skipped: null });
  });

  it('counts a transient failure without deleting the registration', async () => {
    listActivePushDevices.mockResolvedValue([{ id: 'row-1', transport: 'unifiedpush', endpoint: 'https://up.example/1' }]);
    sendNativePush.mockResolvedValue('retry');

    const summary = await dispatchMailNotification(event());

    expect(markPushDeviceFailure).toHaveBeenCalledWith('row-1');
    expect(disablePushDevice).not.toHaveBeenCalled();
    expect(summary.native.retry).toBe(1);
  });

  it('delivers native push even when the Web Push leg throws', async () => {
    sendPushToUser.mockRejectedValue(new Error('web push service down'));
    listActivePushDevices.mockResolvedValue([{ id: 'row-1', transport: 'fcm', endpoint: 'token-1' }]);

    const summary = await dispatchMailNotification(event());

    expect(summary.webPush).toBe('error');
    expect(summary.native.delivered).toBe(1);
    expect(sendNativePush).toHaveBeenCalledTimes(1);
  });

  it('survives a device-lookup failure and still runs Web Push', async () => {
    listActivePushDevices.mockRejectedValue(new Error('db down'));
    const summary = await dispatchMailNotification(event());
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(summary.native.skipped).toBe('lookup-failed');
  });

  it('does not dispatch the same persisted message twice inside the dedup window', async () => {
    const first = await dispatchMailNotification(event());
    const second = await dispatchMailNotification(event());

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.skipped).toBe('duplicate');
    expect(sendPushToUser).toHaveBeenCalledTimes(1);

    // A different message is not suppressed.
    const third = await dispatchMailNotification(event({ eventId: 'msg-2' }));
    expect(third.dispatched).toBe(true);
  });

  it('skips an event that has no stable id', async () => {
    const summary = await dispatchMailNotification(event({ eventId: null, native: null }));
    expect(summary.dispatched).toBe(false);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
