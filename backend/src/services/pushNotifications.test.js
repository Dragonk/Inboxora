import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const { sendNotification, query, delay } = vi.hoisted(() => ({ sendNotification: vi.fn(), query: vi.fn(), delay: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));
vi.mock('./db.js', () => ({ query }));
vi.mock('node:timers/promises', () => ({ setTimeout: delay }));
beforeEach(() => {
  vi.resetModules(); vi.stubEnv('VAPID_PUBLIC_KEY', 'synthetic'); vi.stubEnv('VAPID_PRIVATE_KEY', 'synthetic');
  query.mockReset().mockResolvedValue({ rows: [{ id: 'device', endpoint: 'https://push.example.test/token', p256dh: 'test', auth: 'test' }] });
  sendNotification.mockReset().mockResolvedValue({ statusCode: 201 }); delay.mockReset().mockResolvedValue();
});
afterEach(() => vi.unstubAllEnvs());
it('requests prompt delivery and retries a temporary push provider failure', async () => {
  sendNotification.mockRejectedValueOnce({ statusCode: 503, headers: { 'retry-after': '2' } });
  const { sendPushToUser } = await import('./pushNotifications.js');
  await sendPushToUser('user', { title: 'Synthetic message' });
  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(sendNotification.mock.calls[0][2]).toEqual({ TTL: 86400, urgency: 'high', timeout: 10000 });
  expect(delay).toHaveBeenCalledWith(2000);
});
it('removes expired endpoints without retrying or blocking another device', async () => {
  query.mockResolvedValueOnce({ rows: [{ id: 'old', endpoint: 'https://push.example.test/old' }, { id: 'new', endpoint: 'https://push.example.test/new' }] });
  sendNotification.mockRejectedValueOnce({ statusCode: 410 });
  const { sendPushToUser } = await import('./pushNotifications.js');
  await sendPushToUser('user', { title: 'Synthetic message' });
  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenLastCalledWith('DELETE FROM push_subscriptions WHERE id = ANY($1)', [['old']]);
  expect(delay).not.toHaveBeenCalled();
});
it('bounds retry attempts on a persistent network failure', async () => {
  sendNotification.mockRejectedValue(new Error('Network failure'));
  const { sendPushToUser } = await import('./pushNotifications.js');
  await sendPushToUser('user', { title: 'Synthetic message' });
  expect(sendNotification).toHaveBeenCalledTimes(3);
});
