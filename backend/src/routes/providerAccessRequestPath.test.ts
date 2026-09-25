import 'express-async-errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

/**
 * The request path consults the capability registry — proved rather than asserted.
 *
 * Every other DAV test runs against the default registry, so a route that still
 * compared `source` against `'local'` itself would pass them just the same. Here
 * the registry is replaced, and the *same* request is allowed or refused purely
 * because the adapter's declaration changed. That is the property P01 added: the
 * capability table decides, and the routes ask it.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

const { registrationFor } = vi.hoisted(() => ({
  registrationFor: {
    value: null as null | ((source: string, feature: string) => unknown),
  },
}));

vi.mock('../services/db.js', () => ({ query }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 500, windowMs: 60_000 } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/davServerAuth.js', () => ({
  createDavAuthMiddleware: () => (req: { davUserId?: string; davCredentialId?: string; davMaxMode?: 'read_only' | 'read_write' }, _res: unknown, next: () => void) => {
    req.davUserId = 'user-1';
    req.davCredentialId = 'credential-1';
    req.davMaxMode = 'read_write';
    next();
  },
}));
// Only the resolver consumes the registry, so replacing it here is enough to put
// the declaration under the test's control.
vi.mock('../services/providers/registry.js', () => ({
  ProviderRegistry: class ProviderRegistry {},
  ProviderRegistryError: class ProviderRegistryError extends Error {},
  createDefaultRegistry: () => ({
    forSource: (source: string, feature: string) => registrationFor.value?.(source, feature),
  }),
}));

import caldavRouter from './caldav.js';
import carddavRouter from './carddav.js';

const AUTH = { authorization: `Basic ${Buffer.from('sam@example.test:secret').toString('base64')}` };
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Sam\r\nEND:VCARD\r\n';

let server: Server;
let base = '';

function declareCalendar(update: 'atomic' | 'unsupported', source = 'local') {
  registrationFor.value = (askedSource, feature) => (
    askedSource === source && feature === 'calendars'
      ? {
        key: 'local',
        source,
        features: ['calendars'],
        writeThrough: false,
        conflictProtection: {
          read: 'atomic', create: 'atomic', update, delete: 'atomic', rsvp: 'best_effort', send: 'unsupported',
        },
      }
      : undefined
  );
}

function declareContacts(update: 'atomic' | 'unsupported', source = 'local') {
  registrationFor.value = (askedSource, feature) => (
    askedSource === source && feature === 'contacts'
      ? {
        key: 'local',
        source,
        features: ['contacts'],
        writeThrough: false,
        conflictProtection: {
          read: 'atomic', create: 'atomic', update, delete: 'atomic', rsvp: 'best_effort', send: 'unsupported',
        },
      }
      : undefined
  );
}

beforeAll(async () => {
  const app = express();
  app.use('/caldav', caldavRouter);
  app.use('/carddav', carddavRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  registrationFor.value = null;
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('a capability declaration changes the response, not only the table', () => {
  it('lets the same local calendar PUT through when the adapter declares update support', async () => {
    declareCalendar('atomic');
    query
      .mockResolvedValueOnce({ rows: [{ id: 'cal-rw', source: 'local', read_only: false, dav_mode: 'read_write' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'e1', etag: 'etag-1' }] });

    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' }, body: ICS,
    });
    expect(response.status).toBe(201);
  });

  it('refuses that exact request once the same adapter declares update unsupported, writing nothing', async () => {
    declareCalendar('unsupported');
    query.mockResolvedValue({ rows: [{ id: 'cal-rw', source: 'local', read_only: false, dav_mode: 'read_write' }] });

    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' }, body: ICS,
    });
    expect(response.status).toBe(403);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO calendar_events'))).toBe(false);
  });

  it('refuses the request when no adapter claims the origin at all', async () => {
    registrationFor.value = () => undefined;
    query.mockResolvedValue({ rows: [{ id: 'cal-rw', source: 'local', read_only: false, dav_mode: 'read_write' }] });

    const response = await fetch(`${base}/caldav/user-1/cal-rw/event.ics`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/calendar' }, body: ICS,
    });
    expect(response.status).toBe(403);
  });

  it('advertises write privileges only while the capability accepts a write', async () => {
    const row = { id: 'cal-rw', name: 'Work', sync_token: 'sync-1', source: 'local', read_only: false, dav_mode: 'read_write' };

    declareCalendar('unsupported');
    query.mockResolvedValue({ rows: [row] });
    const refused = await fetch(`${base}/caldav/user-1/cal-rw/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(refused.status).toBe(207);
    expect(await refused.text()).not.toContain('<D:write');

    declareCalendar('atomic');
    query.mockResolvedValue({ rows: [row] });
    const offered = await fetch(`${base}/caldav/user-1/cal-rw/`, { method: 'PROPFIND', headers: { ...AUTH, depth: '0' } });
    expect(offered.status).toBe(207);
    expect(await offered.text()).toContain('<D:write');
  });

  it('gives CardDAV the same capability-driven answer for a contact PUT', async () => {
    const book = { id: 'book-1', name: 'Personal', sync_token: 'sync-1', sync_version: 1, source: 'local', dav_mode: 'read_write' };

    declareContacts('unsupported');
    query.mockResolvedValue({ rows: [book] });
    const refused = await fetch(`${base}/carddav/user-1/book-1/c1.vcf`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/vcard' }, body: VCARD,
    });
    expect(refused.status).toBe(403);

    declareContacts('atomic');
    query
      .mockResolvedValueOnce({ rows: [book] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uid: 'c1', etag: 'etag-1' }] });
    const accepted = await fetch(`${base}/carddav/user-1/book-1/c1.vcf`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'text/vcard' }, body: VCARD,
    });
    expect([201, 204]).toContain(accepted.status);
  });
});
