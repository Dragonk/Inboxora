import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';
import type { JsonBody } from '../test/json.js';

// The route's provider branch is what this suite pins: which accounts it calls out for,
// that a provider failure is reported beside the local results instead of failing them,
// and that the operator switch stops the outbound call. The adapter itself is mocked —
// its landing behaviour is covered by graphMailSearch.integration.test.ts.
const ingestMock = vi.hoisted(() => vi.fn());
const gmailMock = vi.hoisted(() => vi.fn());

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/providers/microsoft/graphMailSearch.js', () => ({ ingestGraphMailSearch: ingestMock }));
vi.mock('../services/providers/google/gmailMailSearch.js', () => ({ ingestGmailMailSearch: gmailMock }));

import express from 'express';
import searchRoutes from './search.js';
import { graphSearchQuery } from '../services/mailSearchRemoteQuery.js';
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(searchTestClock += 60000);
  searchQueries = 0;
  gmailMock.mockReset();
  gmailMock.mockResolvedValue({rowIds:[],truncated:false});
  ingestMock.mockReset();
  ingestMock.mockResolvedValue({ accountId: 'a1', hits: 0, created: 0, updated: 0, skipped: 0, unresolvedFolders: 0, rowIds: [], truncated: false });
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

let searchTestClock = Date.now();
afterEach(() => vi.useRealTimers());

describe('GET /api/search provider-side search', () => {
  it('ingests from a native Microsoft account before answering from the local model', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'm1', subject: 'Invoice' }]];

    const response = await getSearch('q=invoice&accountId=a1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ id: 'm1' }], query: 'invoice' });
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(ingestMock).toHaveBeenCalledWith({
      userId: 'user-1', connectionId: 'connection-1', accountId: 'a1', query: graphSearchQuery('invoice'), folders: null, maxResults: 51,
    });
  });

  it('does not call normal provider pagination an incomplete search', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'm1', subject: 'Invoice' }]];
    ingestMock.mockResolvedValue({ accountId:'a1', hits:51, created:0, updated:0, skipped:0, unresolvedFolders:0, rowIds:['m1'], truncated:true });

    const response = await getSearch('q=invoice&accountId=a1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages:[{id:'m1'}], partial:false, coverage:'provider_and_local' });
  });

  it('does not show incomplete coverage just because Gmail has another result page', async () => {
    accounts = [{ id:'g1', user_id:'user-1', include_in_unified_inbox:true, mail_transport:'gmail_api', provider_connection_id:'google-1' }];
    localPages = [[{ id:'m1', subject:'Invoice' }]];
    gmailMock.mockResolvedValue({ rowIds:['m1'], truncated:true, coverageIncomplete:false });

    const response = await getSearch('q=invoice&accountId=g1');

    expect(response.status).toBe(200);
    const body = await response.json() as JsonBody;
    expect(body.messages).toEqual([{ id:'m1', subject:'Invoice' }]);
    expect(body.partial).toBe(false);
    expect(body.providerErrors).toBeUndefined();
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
    expect(body.providerErrors).toEqual([{ accountId: 'a1', code: 'RATE_LIMITED', error: expect.stringContaining('mail server could not complete') }]);
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

  it('searches native Gmail through its own provider adapter', async () => {
    accounts = [{ id: 'g1', user_id: 'user-1', include_in_unified_inbox: true, mail_transport: 'gmail_api', provider_connection_id: 'google-1' }];
    localPages = [[{ id: 'm1' }]];

    const response = await getSearch('q=invoice&accountId=g1');

    expect(response.status).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
    expect(gmailMock).toHaveBeenCalledExactlyOnceWith({userId:'user-1',accountId:'g1',connectionId:'google-1',query:'invoice',folders:null,maxResults:51});
  });

  it('queries remote accounts before reading their updated local projection', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [[{ id: 'local-1' }, { id: 'ingested-1' }]];

    const response = await getSearch('q=invoice');

    expect(response.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(searchQueries).toBe(1);
    expect((await response.json() as JsonBody).messages).toEqual([{ id: 'local-1' }, { id: 'ingested-1' }]);
  });

  it('also checks remote coverage when the local page is full', async () => {
    accounts = [GRAPH_ACCOUNT];
    localPages = [Array.from({ length: 50 }, (_, index) => ({ id: `local-${index}` }))];

    const response = await getSearch('q=invoice');

    expect(response.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(searchQueries).toBe(1);
  });
});
