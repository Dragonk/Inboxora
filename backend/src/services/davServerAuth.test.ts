import { describe, expect, it, vi } from 'vitest';
import type { logAuthEvent as logAuthEventContract } from './authEvents.js';
import type { authenticateDavCredential as authenticateDavCredentialContract } from './davCredentials.js';
import type { consume as consumeContract } from './rateLimiter.js';

const { authenticateDavCredential, consume, logAuthEvent } = vi.hoisted(() => ({
  authenticateDavCredential: vi.fn<typeof authenticateDavCredentialContract>(),
  consume: vi.fn<typeof consumeContract>(),
  logAuthEvent: vi.fn<typeof logAuthEventContract>(),
}));
vi.mock('./davCredentials.js', () => ({ authenticateDavCredential }));
vi.mock('./rateLimiter.js', () => ({ consume }));
vi.mock('./authEvents.js', () => ({ logAuthEvent }));

import { createDavAuthMiddleware } from './davServerAuth.js';

type DavResponse = {
  end(): void;
  setHeader(name: string, value: string): void;
  status(code: number): Pick<DavResponse, 'end'>;
};

function response(): DavResponse {
  const end = vi.fn<() => void>();
  return {
    end,
    setHeader: vi.fn<(name: string, value: string) => void>(),
    status: vi.fn<(code: number) => Pick<DavResponse, 'end'>>(() => ({ end })),
  };
}

describe('createDavAuthMiddleware', () => {
  it('authenticates a dedicated DAV credential and attaches its ownership to the request', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    const middleware = createDavAuthMiddleware({ realm: 'Inboxora CalDAV', eventType: 'caldav_auth_fail' });
    const req: { headers: Record<string, string>; ip?: string; davCredentialId?: string; davUserId?: string } = { headers: { authorization: `Basic ${Buffer.from('sam@example.test:test-dav-password').toString('base64')}` }, ip: '127.0.0.1' };
    const res = response();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(authenticateDavCredential).toHaveBeenCalledWith('sam@example.test', 'test-dav-password');
    expect(req.davUserId).toBe('user-1');
    expect(req.davCredentialId).toBe('credential-1');
    expect(next).toHaveBeenCalledOnce();
  });
});
