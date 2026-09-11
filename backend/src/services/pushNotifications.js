import webPush from 'web-push';
import { query } from './db.js';
import { setTimeout as delay } from 'node:timers/promises';

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
// subject must be either a mailto: or an https: URL identifying the sender
const vapidSubject =
  process.env.VAPID_SUBJECT ||
  (process.env.APP_URL ? process.env.APP_URL : 'mailto:admin@mailflow.local');

export const pushConfigured = !!(vapidPublicKey && vapidPrivateKey);

if (pushConfigured) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.log('Push notifications disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set.');
}

/**
 * Send a Web Push notification to every subscribed device for a user.
 * Stale subscriptions (410 / 404 from the push service) are pruned automatically.
 * Errors from individual devices never throw — they are logged and skipped so
 * one bad subscription can't block delivery to the rest.
 */
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured) return;

  const result = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return;

  const body = JSON.stringify(payload);
  const staleIds = [];

  await Promise.allSettled(result.rows.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await webPush.sendNotification(subscription, body, {
          TTL: 86400,
          urgency: 'high',
          timeout: 10000,
        });
        break;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          staleIds.push(row.id);
          break;
        }
        const transient = !err.statusCode || err.statusCode === 429 || err.statusCode >= 500;
        if (!transient || attempt === 2) {
          console.warn(`Push delivery failed (${err.statusCode || 'network'}, attempt ${attempt + 1})`);
          break;
        }
        const retryAfter = err.headers?.['retry-after'];
        const requestedDelay = /^\d+$/.test(String(retryAfter || ''))
          ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        await delay(Math.min(60000, Math.max(1000 * (2 ** attempt), Number.isFinite(requestedDelay) ? requestedDelay : 0)));
      }
    }
  }));

  if (staleIds.length > 0) {
    await query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [staleIds])
      .catch(err => console.error('Failed to prune stale push subscriptions:', err.message));
  }
}
