import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatePushDevice, bearerTokenFromHeader } = vi.hoisted(() => ({
  authenticatePushDevice: vi.fn(),
  bearerTokenFromHeader: vi.fn(),
}));
vi.mock('../services/pushDevices.js', () => ({ authenticatePushDevice, bearerTokenFromHeader }));

import { requireDeviceAuth } from './deviceAuth.js';

function harness(headers = {}) {
  const req = { get: (name) => headers[name.toLowerCase()] };
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  authenticatePushDevice.mockReset();
  bearerTokenFromHeader.mockReset();
});

describe('requireDeviceAuth', () => {
  it('attaches the resolved device and calls next for a valid token', async () => {
    bearerTokenFromHeader.mockReturnValue('mf_push_x.secret');
    authenticatePushDevice.mockResolvedValue({ id: 'row-1', userId: 'user-1', deviceId: 'device-1' });
    const { req, res, next } = harness({ authorization: 'Bearer mf_push_x.secret' });

    await requireDeviceAuth(req, res, next);

    expect(req.pushDevice).toEqual({ id: 'row-1', userId: 'user-1', deviceId: 'device-1' });
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
  });

  it('rejects a missing or invalid bearer token with 401 and never calls next', async () => {
    bearerTokenFromHeader.mockReturnValue(null);
    const missing = harness({});
    await requireDeviceAuth(missing.req, missing.res, missing.next);
    expect(missing.res.statusCode).toBe(401);
    expect(missing.next).not.toHaveBeenCalled();

    bearerTokenFromHeader.mockReturnValue('mf_push_x.secret');
    authenticatePushDevice.mockResolvedValue(null);
    const invalid = harness({ authorization: 'Bearer mf_push_x.secret' });
    await requireDeviceAuth(invalid.req, invalid.res, invalid.next);
    expect(invalid.res.statusCode).toBe(401);
    expect(invalid.next).not.toHaveBeenCalled();
  });

  it('forwards a lookup failure to the error handler instead of authenticating', async () => {
    bearerTokenFromHeader.mockReturnValue('mf_push_x.secret');
    authenticatePushDevice.mockRejectedValue(new Error('db down'));
    const { req, res, next } = harness({ authorization: 'Bearer mf_push_x.secret' });

    await requireDeviceAuth(req, res, next);

    expect(req.pushDevice).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
