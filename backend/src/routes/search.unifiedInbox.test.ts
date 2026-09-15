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

import express from 'express';
import searchRoutes from './search.js';
import { query as __mock_query } from '../services/db.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

function accountIdsFromSearchQuery(): unknown {
  const searchQueryCall = query.mock.calls[1];
  if (searchQueryCall === undefined) {
    throw new Error('Expected the search query to be called after account lookup');
  }

  const searchQueryParams = searchQueryCall[1];
  if (searchQueryParams === undefined) {
    throw new Error('Expected the search query to receive parameters');
  }

  const accountIds = searchQueryParams[0];
  if (!Array.isArray(accountIds)) {
    throw new Error('Expected the search query to receive account IDs');
  }

  return accountIds;
}

describe('GET /api/search unified account scope', () => {
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
  });

  it('searches only opted-in accounts when no account is selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice`);

    expect(response.status).toBe(200);
    expect(accountIdsFromSearchQuery()).toEqual(['included']);
  });

  it('keeps an opted-out account searchable when explicitly selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice&accountId=excluded`);

    expect(response.status).toBe(200);
    expect(accountIdsFromSearchQuery()).toEqual(['excluded']);
  });
});
