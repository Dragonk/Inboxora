// Fan-out for the canonical mail notification event.
//
//   IMAP IDLE / mail sync
//        -> new message persisted
//        -> buildMailNotificationEvent()   (mailNotificationEvent.js)
//        -> dispatchMailNotification()     (this file)
//              |-> Web Push  -> push_subscriptions (PWA)
//              |-> Android   -> push_devices      (FCM / UnifiedPush)
//
// Every leg is isolated: a failing provider, a malformed endpoint or a database
// hiccup in one transport can never block the others. Permanent provider
// rejections disable that one registration; transient failures are counted and
// retried by the next event. No endpoint/token is ever logged.
import { pushConfigured, sendPushToUser } from './pushNotifications.js';
import { disablePushDevice, listActivePushDevices, markPushDeviceFailure } from './pushDevices.js';
import { TRANSPORT_INVALID, TRANSPORT_RETRY, sendNativePush } from './pushTransports.js';

// Defence-in-depth against a duplicate emission of the same persisted message
// (e.g. two sync ticks racing to report the same arrival). Bounded and
// per-process: the client-side cache is the authoritative dedup because only the
// device knows whether a notification for this message is already on screen.
const DEDUP_TTL_MS = 60_000;
const DEDUP_MAX = 2000;
const recentEvents = new Map();

function alreadyDispatched(userId, eventId) {
  if (!eventId) return false;
  const key = `${userId}:${eventId}`;
  const now = Date.now();
  const previous = recentEvents.get(key);
  recentEvents.set(key, now);
  if (recentEvents.size > DEDUP_MAX) {
    for (const [entryKey, seenAt] of recentEvents) {
      if (now - seenAt > DEDUP_TTL_MS || recentEvents.size > DEDUP_MAX) recentEvents.delete(entryKey);
      if (recentEvents.size <= DEDUP_MAX) break;
    }
  }
  return previous != null && now - previous < DEDUP_TTL_MS;
}

export function resetDispatchDedup() {
  recentEvents.clear();
}

async function dispatchWebPush(event, summary) {
  if (!pushConfigured) {
    summary.webPush = 'disabled';
    return;
  }
  try {
    await sendPushToUser(event.userId, event.webPush);
    summary.webPush = 'delivered';
  } catch (err) {
    summary.webPush = 'error';
    console.warn('Web Push dispatch failed:', err.message);
  }
}

async function dispatchNative(event, summary) {
  if (!event.native?.eventId) {
    summary.native.skipped = 'no-event-id';
    return;
  }

  let devices;
  try {
    devices = await listActivePushDevices(event.userId);
  } catch (err) {
    summary.native.skipped = 'lookup-failed';
    console.warn('Native push device lookup failed:', err.message);
    return;
  }

  await Promise.allSettled(devices.map(async (device) => {
    let verdict;
    try {
      verdict = await sendNativePush(device, event.native);
    } catch (err) {
      // A transport must not throw, but a bug must not take the whole fan-out down.
      verdict = TRANSPORT_RETRY;
      console.warn(`Native push transport ${device.transport} threw:`, err.message);
    }

    if (verdict === TRANSPORT_INVALID) {
      summary.native.invalid += 1;
      await disablePushDevice(device.id).catch(() => {});
    } else if (verdict === TRANSPORT_RETRY) {
      summary.native.retry += 1;
      await markPushDeviceFailure(device.id).catch(() => {});
    } else if (verdict === 'delivered') {
      summary.native.delivered += 1;
    } else {
      summary.native.disabled += 1;
    }
  }));
}

export async function dispatchMailNotification(event) {
  const summary = {
    dispatched: false,
    webPush: 'skipped',
    native: { delivered: 0, invalid: 0, retry: 0, disabled: 0, skipped: null },
  };
  if (!event?.userId || !event?.eventId) return summary;
  if (alreadyDispatched(event.userId, event.eventId)) {
    summary.skipped = 'duplicate';
    return summary;
  }

  summary.dispatched = true;
  await Promise.allSettled([
    dispatchWebPush(event, summary),
    dispatchNative(event, summary),
  ]);
  return summary;
}
