import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticateDavCredential, query } = vi.hoisted(() => ({
  authenticateDavCredential: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../services/davCredentials.js', () => ({ authenticateDavCredential }));
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 60_000 } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));

import express from 'express';
import carddavRouter from './carddav.js';

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/carddav', carddavRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  authenticateDavCredential.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('CardDAV authentication', () => {
  it('accepts only a dedicated DAV app password', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/carddav/`, {
      method: 'OPTIONS',
      headers: { authorization: basic('sam@example.test', 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456') },
    });

    expect(response.status).toBe(200);
    expect(authenticateDavCredential).toHaveBeenCalledWith(
      'sam@example.test',
      'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456',
    );
  });

  it('rejects credentials which are not an active DAV app password', async () => {
    authenticateDavCredential.mockResolvedValue(null);

    const response = await fetch(`${base}/carddav/`, {
      method: 'OPTIONS',
      headers: { authorization: basic('sam@example.test', 'primary-account-password') },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Inboxora CardDAV');
  });

  it('rejects writes to an imported address book', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'carddav' }] });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Imported Contact\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(403);
  });
});
