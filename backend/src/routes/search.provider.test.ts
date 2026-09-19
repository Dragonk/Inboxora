import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';

// The route's provider branch is what this suite pins: which accounts it calls out for,
// that a provider failure is reported beside the local results instead of failing them,
// and that the operator switch stops the outbound call. The adapter itself is mocked —
// its landing behaviour is covered by graphMailSearch.integration.test.ts.
const ingestMock = vi.hoisted(() => vi.fn());

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/providers/microsoft/graphMailSearch.js', () => ({ ingestGraphMailSearch: ingestMock }));

import express from 'express';
import searchRoutes from './search.js';
import { query as __mock_query } from '../services/db.js';

const query = vi.mocked(__mock_query);

const GRAPH_ACCOUNT = {
  id: 'a1', user_id: 'user-1', include_in_unified_inbox: true,
  mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1',
};

let accounts: unknown[] = [];
let localPages: unknown[][] = [];
let searchQueries = 0;

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

let server: Server;
let base = '';

beforeAll(async () => {
  await new Promise<void>(resolve => { server = buildApp().listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  searchQueries = 0;
  ingestMock.mockReset();
  ingestMock.mockResolvedValue({ accountId: 'a1', hits: 0, created: 0, updated: 0, skipped: 0, unresolvedFolders: 0 });
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM email_accounts')) return { rows: accounts };
    const rows = localPages[Math.min(searchQueries, localPages.length - 1)] ?? [];
    searchQueries += 1;
    return { rows };
  });
});

afterEach(() => {
  delete process.env.PROVIDER_INTEGRATIONS_ENABLED;
});

const getSearch = (queryStringValue: string) => fetch(`${base}/api/search?${queryStringValue}`);

describe('GET /api/search provider-side search', () => {
  it('ingests from a native Microsoft account before answering from the local model', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'm1', subject: 'Invoice' }]];

    const response = await getSearch('q=invoice&accountId=a1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ id: 'm1' }], query: 'invoice' });
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(ingestMock).toHaveBeenCalledWith({
      userId: 'user-1', connectionId: 'connection-1', accountId: 'a1', query: 'invoice',
    });
  });

  it('reports a provider failure beside the local results instead of failing the search', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'm1' }]];
    ingestMock.mockRejectedValue(Object.assign(new Error('graph refused'), { code: 'RATE_LIMITED' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await getSearch('q=invoice&accountId=a1');

    expect(response.status).toBe(200);
    const body = await response.json() as JsonBody;
    expect(body.messages).toEqual([{ id: 'm1' }]);
    expect(body.providerErrors).toEqual([{ accountId: 'a1', code: 'RATE_LIMITED', error: 'graph refused' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Provider search failed for account a1'));
    warn.mockRestore();
  });

  it('makes no outbound search at all when the provider layer is switched off', async () => {
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'm1' }]];

    const response = await getSearch('q=invoice&accountId=a1');

    expect(response.status).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('decides on the account transport: a Google account still searches locally only', async () => {
    accounts = [{ id: 'g1', user_id: 'user-1', include_in_unified_inbox: true, mail_transport: 'gmail_api', provider_connection_id: 'google-1' }];
    localPages = [[{ id: 'm1' }]];

    const response = await getSearch('q=invoice&accountId=g1');

    expect(response.status).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('ingests over all accounts only when the local page came up short, then re-reads', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'local-1' }], [{ id: 'local-1' }, { id: 'ingested-1' }]];

    const response = await getSearch('q=invoice');

    expect(response.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(searchQueries).toBe(2);
    expect((await response.json() as JsonBody).messages).toEqual([{ id: 'local-1' }, { id: 'ingested-1' }]);
  });

  it('does not call the provider when the local page is already full', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [Array.from({ length: 50 }, (_, index) => ({ id: `local-${index}` }))];

    const response = await getSearch('q=invoice');

    expect(response.status).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
    expect(searchQueries).toBe(1);
  });
});
