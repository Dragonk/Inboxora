import { describe, expect, it, vi } from 'vitest';

const { authenticateDavCredential, consume, logAuthEvent } = vi.hoisted(() => ({
  authenticateDavCredential: vi.fn(),
  consume: vi.fn(),
  logAuthEvent: vi.fn(),
}));
vi.mock('./davCredentials.js', () => ({ authenticateDavCredential }));
vi.mock('./rateLimiter.js', () => ({ consume }));
vi.mock('./authEvents.js', () => ({ logAuthEvent }));

import { createDavAuthMiddleware } from './davServerAuth.js';

function response() {
  return {
    end: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(function status() { return this; }),
  };
}

describe('createDavAuthMiddleware', () => {
  it('authenticates a dedicated DAV credential and attaches its ownership to the request', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    const middleware = createDavAuthMiddleware({ realm: 'Inboxora CalDAV', eventType: 'caldav_auth_fail' });
    const req = { headers: { authorization: `Basic ${Buffer.from('sam@example.test:test-dav-password').toString('base64')}` }, ip: '127.0.0.1' };
    const res = response();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(authenticateDavCredential).toHaveBeenCalledWith('sam@example.test', 'test-dav-password');
    expect(req.davUserId).toBe('user-1');
    expect(req.davCredentialId).toBe('credential-1');
    expect(next).toHaveBeenCalledOnce();
  });
});
