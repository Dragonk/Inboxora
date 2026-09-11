import { describe, expect, it, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query }));
vi.mock('./encryption.js', () => ({
  encrypt: (value) => `enc:v1:${value}`,
  decrypt: (value) => (typeof value === 'string' ? value.replace(/^enc:v1:/, '') : value),
}));

import bcrypt from 'bcryptjs';
import {
  authenticatePushDevice,
  bearerTokenFromHeader,
  disablePushDevice,
  parseDeviceToken,
  registerPushDevice,
  removePushDevice,
  validateDeviceRegistration,
} from './pushDevices.js';

beforeEach(() => query.mockReset());

describe('device tokens', () => {
  it('parses only well-formed mf_push tokens', () => {
    const token = 'mf_push_11111111-2222-3333-4444-555555555555.abcdefghijklmnop';
    expect(parseDeviceToken(token)).toEqual({
      prefix: 'mf_push_11111111-2222-3333-4444-555555555555',
      secret: 'abcdefghijklmnop',
    });
    expect(parseDeviceToken('mf_dav_11111111-2222-3333-4444-555555555555.abcdefghijklmnop')).toBeNull();
    expect(parseDeviceToken('mf_push_nope')).toBeNull();
    expect(parseDeviceToken(null)).toBeNull();
  });

  it('extracts a bearer token case-insensitively and rejects other schemes', () => {
    expect(bearerTokenFromHeader('Bearer mf_push_x.y')).toBe('mf_push_x.y');
    expect(bearerTokenFromHeader('bearer   mf_push_x.y')).toBe('mf_push_x.y');
    expect(bearerTokenFromHeader('Basic abc')).toBeNull();
    expect(bearerTokenFromHeader(undefined)).toBeNull();
  });
});

describe('device registration validation', () => {
  it('accepts a valid UnifiedPush registration', () => {
    expect(validateDeviceRegistration({
      deviceId: 'device-1', platform: 'android', transport: 'unifiedpush',
      endpoint: 'https://ntfy.example.com/up/abc', appVersion: '4.0.0',
    })).toEqual({
      deviceId: 'device-1', platform: 'android', transport: 'unifiedpush',
      endpoint: 'https://ntfy.example.com/up/abc', appVersion: '4.0.0',
    });
  });

  it('rejects unknown platforms and transports', () => {
    expect(() => validateDeviceRegistration({ deviceId: 'd', platform: 'symbian', transport: 'fcm', endpoint: 'x' })).toThrow(/platform/i);
    expect(() => validateDeviceRegistration({ deviceId: 'd', platform: 'android', transport: 'carrier-pigeon', endpoint: 'x' })).toThrow(/transport/i);
  });

  it('requires HTTPS for a UnifiedPush endpoint', () => {
    expect(() => validateDeviceRegistration({ deviceId: 'd', platform: 'android', transport: 'unifiedpush', endpoint: 'http://ntfy.local/up' })).toThrow(/HTTPS/);
    expect(() => validateDeviceRegistration({ deviceId: 'd', platform: 'android', transport: 'unifiedpush', endpoint: 'not-a-url' })).toThrow(/valid URL/);
  });

  it('accepts a plain-http /push endpoint only for a LAN install that opted in', () => {
    vi.stubEnv('PUSH_ALLOW_PRIVATE_ENDPOINTS', 'true');
    expect(validateDeviceRegistration({
      deviceId: 'd', platform: 'android', transport: 'unifiedpush',
      endpoint: 'http://192.168.1.10/push/upABCDEF123456?up=1',
    })).toMatchObject({ endpoint: 'http://192.168.1.10/push/upABCDEF123456?up=1' });
    vi.unstubAllEnvs();
  });

  it('requires a device id and an endpoint', () => {
    expect(() => validateDeviceRegistration({ platform: 'android', transport: 'fcm', endpoint: 'token' })).toThrow(/deviceId/);
    expect(() => validateDeviceRegistration({ deviceId: 'd', platform: 'android', transport: 'fcm' })).toThrow(/endpoint/);
  });
});

describe('registerPushDevice', () => {
  it('encrypts the endpoint and returns a one-time device token', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-1', device_id: 'device-1', platform: 'android', transport: 'fcm' }] });

    const { device, deviceToken } = await registerPushDevice('user-1', {
      deviceId: 'device-1', platform: 'android', transport: 'fcm', endpoint: 'fcm-registration-token',
    });

    expect(device.id).toBe('row-1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO push_devices');
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe('device-1');
    // Endpoint is encrypted at rest, never stored in the clear.
    expect(params[4]).toBe('enc:v1:fcm-registration-token');
    // The device token is stored only as a bcrypt hash + public prefix.
    expect(params[5]).toMatch(/^mf_push_[0-9a-f-]{36}$/);
    expect(params[6]).toMatch(/^\$2[aby]\$/);
    expect(parseDeviceToken(deviceToken)).toEqual({ prefix: params[5], secret: expect.any(String) });
  });

  it('pins the row to the caller user id (no cross-user registration)', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] });
    await registerPushDevice('victim-user', { deviceId: 'd', platform: 'android', transport: 'fcm', endpoint: 't' });
    expect(query.mock.calls[0][1][0]).toBe('victim-user');
  });
});

describe('authenticatePushDevice', () => {
  it('returns the owner only when the secret matches the stored hash', async () => {
    const token = 'mf_push_11111111-2222-3333-4444-555555555555.secretsecretsecret';
    const parsed = parseDeviceToken(token);
    const hash = await bcrypt.hash(parsed.secret, 4);
    // Vitest calls a reset mock's implementation with no args during cleanup, so
    // only string SQL is treated as a real query.
    query.mockImplementation((...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql.includes('FROM push_devices')) return Promise.resolve({ rows: [{ id: 'row-1', user_id: 'user-1', device_id: 'device-1', transport: 'fcm', token_hash: hash }] });
      return Promise.resolve({ rows: [] });
    });

    await expect(authenticatePushDevice(token)).resolves.toEqual({ id: 'row-1', userId: 'user-1', deviceId: 'device-1', transport: 'fcm' });
    // Prefix lookup is exact and only considers active devices.
    const lookup = query.mock.calls.find((call) => typeof call[0] === 'string' && call[0].includes('FROM push_devices'));
    expect(lookup[1]).toEqual([parsed.prefix]);
  });

  it('rejects a wrong secret and an unknown prefix', async () => {
    const parsed = parseDeviceToken('mf_push_11111111-2222-3333-4444-555555555555.secretsecretsecret');
    const hash = await bcrypt.hash('a-different-secret-value', 4);
    query.mockImplementation((sql) => {
      if (sql.includes('FROM push_devices')) return Promise.resolve({ rows: [{ id: 'row-1', user_id: 'user-1', token_hash: hash }] });
      return Promise.resolve({ rows: [] });
    });
    await expect(authenticatePushDevice('mf_push_11111111-2222-3333-4444-555555555555.secretsecretsecret')).resolves.toBeNull();

    query.mockReset().mockResolvedValue({ rows: [] });
    await expect(authenticatePushDevice('mf_push_11111111-2222-3333-4444-555555555555.secretsecretsecret')).resolves.toBeNull();
    expect(parsed).not.toBeNull();
  });
});

describe('removal and disabling', () => {
  it('scopes deletion to the owning user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-1', device_id: 'device-1' }] });
    await removePushDevice('user-1', 'device-1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('DELETE FROM push_devices WHERE user_id = $1 AND device_id = $2');
    expect(params).toEqual(['user-1', 'device-1']);
  });

  it('clears the endpoint and token when permanently disabling a device', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await disablePushDevice('row-1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('disabled_at = NOW()');
    expect(sql).toContain("endpoint = ''");
    expect(sql).toContain('token_hash = NULL');
    expect(params).toEqual(['row-1']);
  });
});
