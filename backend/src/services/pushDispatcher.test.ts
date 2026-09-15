import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchMailNotification, resetDispatchDedup } from './pushDispatcher.js';

type DispatchEvent = Parameters<typeof dispatchMailNotification>[0];
type PushDevice = Parameters<typeof import('./pushTransports.js').sendNativePush>[0];
type NativeEvent = NonNullable<DispatchEvent['native']>;
type NativeVerdict = 'delivered' | 'invalid' | 'retry' | 'disabled';

const { sendPushToUser, listActivePushDevices, disablePushDevice, markPushDeviceFailure, sendNativePush } = vi.hoisted(() => ({
  sendPushToUser: vi.fn<(userId: string, payload: unknown) => Promise<void>>(),
  listActivePushDevices: vi.fn<(userId: string) => Promise<PushDevice[]>>(),
  disablePushDevice: vi.fn<(id: unknown) => Promise<void>>(),
  markPushDeviceFailure: vi.fn<(id: unknown) => Promise<void>>(),
  sendNativePush: vi.fn<(device: PushDevice, event: NativeEvent) => Promise<NativeVerdict>>(),
}));

vi.mock('./pushNotifications.js', () => ({ pushConfigured: true, sendPushToUser }));
vi.mock('./pushDevices.js', () => ({ listActivePushDevices, disablePushDevice, markPushDeviceFailure }));
vi.mock('./pushTransports.js', () => ({
  sendNativePush,
  TRANSPORT_INVALID: 'invalid',
  TRANSPORT_RETRY: 'retry',
}));

function event(): DispatchEvent {
  return {
    userId: 'user-1',
    eventId: 'msg-1',
    webPush: { title: 'Ada', body: 'Hello' },
    native: { type: 'mail.changed', eventId: 'msg-1' },
  };
}

function eventWithId(eventId: string): DispatchEvent {
  return { ...event(), eventId, native: { type: 'mail.changed', eventId } };
}

function eventWithoutStableId(): DispatchEvent {
  return { ...event(), eventId: null, native: null };
}

beforeEach(() => {
  resetDispatchDedup();
  sendPushToUser.mockReset().mockResolvedValue(undefined);
  listActivePushDevices.mockReset().mockResolvedValue([]);
  disablePushDevice.mockReset().mockResolvedValue(undefined);
  markPushDeviceFailure.mockReset().mockResolvedValue(undefined);
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
    const firstNativeCall = sendNativePush.mock.calls.at(0);
    if (!firstNativeCall) throw new Error('Expected a native push call');
    expect(firstNativeCall[1]).toEqual({ type: 'mail.changed', eventId: 'msg-1' });
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
    const third = await dispatchMailNotification(eventWithId('msg-2'));
    expect(third.dispatched).toBe(true);
  });

  it('skips an event that has no stable id', async () => {
    const summary = await dispatchMailNotification(eventWithoutStableId());
    expect(summary.dispatched).toBe(false);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
