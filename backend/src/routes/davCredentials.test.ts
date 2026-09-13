import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { createDavAppPassword, listDavAppPasswords, revokeDavAppPassword } = vi.hoisted(() => ({
  createDavAppPassword: vi.fn(),
  listDavAppPasswords: vi.fn(),
  revokeDavAppPassword: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/davAppPasswords.js', () => ({
  createDavAppPassword,
  listDavAppPasswords,
  revokeDavAppPassword,
}));

import express from 'express';
import davCredentialsRouter from './davCredentials.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/dav-credentials', davCredentialsRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  createDavAppPassword.mockReset();
  listDavAppPasswords.mockReset();
  revokeDavAppPassword.mockReset();
});

describe('DAV application password API', () => {
  it('returns only safe credential metadata when listing a user credentials', async () => {
    listDavAppPasswords.mockResolvedValue([{ id: 'credential-1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z', last_used_at: null }]);

    const response = await fetch(`${base}/api/dav-credentials`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credentials: [{ id: 'credential-1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z', last_used_at: null }] });
    expect(listDavAppPasswords).toHaveBeenCalledWith('user-1');
  });

  it('returns a new DAV secret only in the creation response', async () => {
    createDavAppPassword.mockResolvedValue({ id: 'credential-1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z', secret: 'mf_dav_example.secret' });

    const response = await fetch(`${base}/api/dav-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'DAVx5 phone' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ credential: { id: 'credential-1', label: 'DAVx5 phone', created_at: '2026-08-30T00:00:00.000Z' }, secret: 'mf_dav_example.secret' });
    expect(createDavAppPassword).toHaveBeenCalledWith('user-1', 'DAVx5 phone');
  });

  it('revokes only an owned active credential', async () => {
    revokeDavAppPassword.mockResolvedValue({ id: 'credential-1', revoked_at: '2026-08-30T00:00:00.000Z' });

    const response = await fetch(`${base}/api/dav-credentials/credential-1`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credential: { id: 'credential-1', revoked_at: '2026-08-30T00:00:00.000Z' } });
    expect(revokeDavAppPassword).toHaveBeenCalledWith('user-1', 'credential-1');
  });
});
