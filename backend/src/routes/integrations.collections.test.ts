import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query }));

import express from 'express';
import session from 'express-session';
import integrationsRouter from './integrations.js';
import { listeningPort } from '../test/net.js';

const collection = (overrides: Record<string, unknown> = {}) => ({
  id: 'collection-1', kind: 'calendar', source: 'microsoft', source_access: 'read_write', user_access: 'source',
  local_calendar_id: 'calendar-1', local_address_book_id: null, ...overrides,
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = 'user-1'; next(); });
  app.use('/api/integrations', integrationsRouter);
  return app;
}

async function patchCollection(body: unknown, row: ReturnType<typeof collection> | null = collection()) {
  mocks.query.mockReset();
  // `requireAuth` resolves the session's user first, so its row precedes the collection lookup.
  mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
  mocks.query.mockResolvedValueOnce({ rows: row ? [row] : [] });
  mocks.query.mockResolvedValue({ rows: [] });
  const server = createApp().listen(0);
  const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/integrations/collections/collection-1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  await new Promise(resolve => server.close(resolve));
  return { status: response.status, body: parsed };
}

function updates(): Array<[string, unknown[]]> {
  return mocks.query.mock.calls.filter((call): call is [string, unknown[]] => String(call[0]).startsWith('UPDATE'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the per-collection write-back opt-in', () => {
  it('enables write-back and mirrors the choice onto the calendar', async () => {
    const response = await patchCollection({ writeBack: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collection: { userAccess: 'read_write', writeBack: true } });
    const [userAccess, calendarFlag] = updates();
    expect(userAccess[0]).toContain('UPDATE integration_collections SET user_access');
    expect(userAccess[1]).toEqual(['collection-1', 'read_write']);
    expect(calendarFlag[0]).toContain('UPDATE calendars SET read_only');
    expect(calendarFlag[1]).toEqual(['calendar-1', false, 'user-1']);
  });

  it('refuses when the provider itself does not allow writes', async () => {
    const response = await patchCollection({ writeBack: true }, collection({ source_access: 'read_only' }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'SOURCE_READ_ONLY' });
    expect(updates()).toHaveLength(0);
  });

  it('refuses when no adapter forwards this kind of write, even if the source would allow it', async () => {
    // A Google calendar: the source permits writes, but the adapter declares no write-through yet.
    const response = await patchCollection({ writeBack: true }, collection({ source: 'google' }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'WRITE_PATH_UNAVAILABLE' });
    expect(updates()).toHaveLength(0);
  });

  it('turns write-back off again, restoring the read-only mirror', async () => {
    const response = await patchCollection({ writeBack: false }, collection({ user_access: 'read_write' }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collection: { userAccess: 'source', writeBack: false } });
    expect(updates()[1][1]).toEqual(['calendar-1', true, 'user-1']);
  });

  it('does not see another user’s collection', async () => {
    const response = await patchCollection({ writeBack: true }, null);
    expect(response.status).toBe(404);
    expect(updates()).toHaveLength(0);
  });

  it('rejects a body that is not a boolean before touching anything', async () => {
    const response = await patchCollection({ writeBack: 'yes' });
    expect(response.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });
});
