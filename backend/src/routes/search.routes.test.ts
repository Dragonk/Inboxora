import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

vi.mock('../services/mailSearch.js', () => ({
  searchMail: vi.fn(),
}));

import express from 'express';
import searchRoutes from './search.js';
import { query as __mock_query } from '../services/db.js';
import { searchMail as __mock_searchMail } from '../services/mailSearch.js';

const query = vi.mocked(__mock_query);
const searchMail = vi.mocked(__mock_searchMail);

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

describe('Search Routes Error Handling', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    searchMail.mockReset();
  });

  describe('GET /api/search', () => {
    it('returns 500 when searchMail throws an unknown error', async () => {
      searchMail.mockRejectedValueOnce(new Error('Search implementation failed'));

      const response = await fetch(`${base}/api/search?q=invoice`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Search failed' });
    });

    it('returns 400 when searchMail throws a 400 error', async () => {
      const error = new Error('Query too long');
      Object.assign(error, { statusCode: 400 });
      searchMail.mockRejectedValueOnce(error);

      const response = await fetch(`${base}/api/search?q=invoice`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Query too long' });
    });
  });

  describe('GET /api/search/contacts', () => {
    it('returns 500 when database query fails during contact fetch', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
      query.mockRejectedValueOnce(new Error('Database connection failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await fetch(`${base}/api/search/contacts?q=john`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to fetch contacts' });

      consoleSpy.mockRestore();
    });

    it('returns 400 when query is too long', async () => {
      const longQuery = 'a'.repeat(101);
      const response = await fetch(`${base}/api/search/contacts?q=${longQuery}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Query too long' });
    });
  });
});
