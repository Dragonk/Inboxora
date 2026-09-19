// Real PostgreSQL + a real local DAV server for the external CalDAV/CardDAV write-back (P10).
// The source is faked at the HTTP boundary; the remote link, the journal claim, the projection and
// the DAV protocol handling are real.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_p10_gate DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/davWriteBack.integration.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import 'express-async-errors';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { listeningPort } from '../../test/net.js';
import { pool, query } from '../db.js';
import { encrypt } from '../encryption.js';
import { invalidateConnectionPolicyCache } from '../connectionPolicy.js';
import type { authenticateDavCredential } from '../davCredentials.js';

type DavCredential = NonNullable<Awaited<ReturnType<typeof authenticateDavCredential>>>;
type DavAuthState = Omit<DavCredential, 'userId'> & { userId: DavCredential['userId'] | null };

const auth = vi.hoisted<DavAuthState>(() => ({ userId: null, credentialId: 'p10-dav-credential', maxDavMode: 'read_write' }));
vi.mock('../davCredentials.js', () => ({ authenticateDavCredential: async () => auth }));
vi.mock('../rateLimiter.js', () => ({ consume: async () => ({ limited: false }) }));
vi.mock('../authEvents.js', () => ({ logAuthEvent: () => {} }));

import caldav from '../../routes/caldav.js';
import carddav from '../../routes/carddav.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;
const originalKey = process.env.ENCRYPTION_KEY;

const EVENT_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260911T090000Z\r\nDTEND:20260911T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const CARD_VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ada Lovelace\r\nEMAIL;TYPE=PREF:ada@example.test\r\nEND:VCARD\r\n';

interface DavRequest { method: string; url: string; headers: IncomingMessage['headers']; body: string }
interface DavState {
  putStatus: number;
  putEtag: string | null;
  deleteStatus: number;
  caldavReport: string;
  carddavReport: string;
  requests: DavRequest[];
}
const dav: DavState = {
  putStatus: 204, putEtag: '"remote-new"', deleteStatus: 204,
  caldavReport: '', carddavReport: '', requests: [],
};

let source: Server;
let davServer: Server;
let sourceBase = '';
let davBase = '';
let userId = '';
const createdUserIds: string[] = [];

const headers = () => ({ authorization: `Basic ${Buffer.from('synthetic:dav-test').toString('base64')}` });

function caldavReport(href: string, etag: string, ical: string): string {
  const data = ical.replace(/\r\n/g, '&#13;&#10;');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>"${etag}"</D:getetag><C:calendar-data>${data}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
}

function carddavReport(href: string, etag: string, vcard: string): string {
  const data = vcard.replace(/\r\n/g, '&#13;&#10;');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>"${etag}"</D:getetag><C:address-data>${data}</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
}

const emptyMultistatus = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"></D:multistatus>';

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  source = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      dav.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.method === 'REPORT') {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.statusCode = 207;
        res.end((req.url ?? '').includes('/calendars/') ? dav.caldavReport : dav.carddavReport);
        return;
      }
      if (req.method === 'PUT') {
        if (dav.putEtag) res.setHeader('ETag', dav.putEtag);
        res.statusCode = dav.putStatus;
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        res.statusCode = dav.deleteStatus;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  });
  await new Promise<void>(resolve => { source.listen(0, '127.0.0.1', resolve); });
  sourceBase = `http://127.0.0.1:${listeningPort(source)}`;
  const app = express();
  app.use('/caldav', caldav);
  app.use('/carddav', carddav);
  await new Promise<void>(resolve => { davServer = app.listen(0, '127.0.0.1', () => resolve()); });
  davBase = `http://127.0.0.1:${listeningPort(davServer)}`;
  await query("INSERT INTO system_settings (key, value) VALUES ('allow_private_hosts', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'");
  invalidateConnectionPolicyCache();
});

afterAll(async () => {
  invalidateConnectionPolicyCache();
  if (source) await new Promise<void>(resolve => source.close(() => resolve()));
  if (davServer) await new Promise<void>(resolve => davServer.close(() => resolve()));
  if (createdUserIds.length) await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  await pool.end();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

beforeEach(async () => {
  dav.putStatus = 204; dav.putEtag = '"remote-new"'; dav.deleteStatus = 204;
  dav.caldavReport = emptyMultistatus; dav.carddavReport = emptyMultistatus; dav.requests = [];
  userId = crypto.randomUUID();
  createdUserIds.push(userId);
  auth.userId = userId;
  await query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [userId, `p10-${userId}`, 'unused']);
});

afterEach(async () => {
  await query('DELETE FROM users WHERE id = $1', [userId]);
  createdUserIds.splice(createdUserIds.indexOf(userId), 1);
});

async function seedSourceConnection(kind: 'caldav' | 'carddav', url: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO source_connections (user_id, kind, label, url_encrypted, url_fingerprint)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, kind, kind, encrypt(url), crypto.createHash('sha256').update(url).digest('hex')],
  );
  return result.rows[0].id;
}

async function seedCaldavCalendar(collectionUrl: string): Promise<string> {
  const source = await query<{ id: string }>(
    `INSERT INTO calendar_import_sources (user_id, kind, url, url_fingerprint, username, password, display_name)
     VALUES ($1, 'caldav', $2, $3, 'sam', $4, 'Work') RETURNING id`,
    [userId, encrypt(collectionUrl), crypto.createHash('sha256').update(collectionUrl).digest('hex'), encrypt('app-password')],
  );
  const calendar = await query<{ id: string }>(
    `INSERT INTO calendars (user_id, owner_user_id, name, source, external_url, read_only, dav_mode)
     VALUES ($1, $1, 'Work', 'caldav', $2, false, 'read_write') RETURNING id`,
    [userId, `source:${source.rows[0].id}`],
  );
  const connectionId = await seedSourceConnection('caldav', collectionUrl);
  await query(
    `INSERT INTO integration_collections (user_id, source_connection_id, kind, remote_id, local_calendar_id, source_access, user_access, dav_mode)
     VALUES ($1, $2, 'calendar', $3, $4, 'read_write', 'read_write', 'read_write')`,
    [userId, connectionId, collectionUrl, calendar.rows[0].id],
  );
  return calendar.rows[0].id;
}

async function seedCarddavBook(collectionUrl: string): Promise<string> {
  await query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', $2::jsonb)`,
    [userId, JSON.stringify({ serverUrl: sourceBase, username: 'sam', password: encrypt('app-password') })],
  );
  const book = await query<{ id: string }>(
    `INSERT INTO address_books (user_id, name, source, external_url, dav_mode)
     VALUES ($1, 'Personal', 'carddav', $2, 'read_write') RETURNING id`,
    [userId, collectionUrl],
  );
  const connectionId = await seedSourceConnection('carddav', collectionUrl);
  await query(
    `INSERT INTO integration_collections (user_id, source_connection_id, kind, remote_id, local_address_book_id, source_access, user_access, dav_mode)
     VALUES ($1, $2, 'address_book', $3, $4, 'read_write', 'read_write', 'read_write')`,
    [userId, connectionId, collectionUrl, book.rows[0].id],
  );
  return book.rows[0].id;
}

async function seedEventLink(calendarId: string, collectionUrl: string, input: { uid: string; href: string; version: string }): Promise<{ eventId: string; linkId: string }> {
  const event = await query<{ id: string }>(
    `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, dav_filename)
     VALUES ($1, $2, $3, $4, 'local-1', 'Planning', NOW(), NOW() + interval '1 hour', $5) RETURNING id`,
    [calendarId, userId, input.uid, EVENT_ICS, `${input.uid}.ics`],
  );
  const link = await query<{ id: string }>(
    `INSERT INTO remote_object_links (user_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
     SELECT $1, ic.id, 'calendar_event', $2, $3, $4, $5, $6, 'active' FROM integration_collections ic
      WHERE ic.local_calendar_id = $7 LIMIT 1
     RETURNING id`,
    [userId, event.rows[0].id, collectionUrl, input.uid, input.href, input.version, calendarId],
  );
  return { eventId: event.rows[0].id, linkId: link.rows[0].id };
}

async function seedContact(bookId: string, uid: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO contacts (address_book_id, user_id, uid, vcard, etag, display_name, dav_filename)
     VALUES ($1, $2, $3, $4, 'local-1', 'Ada Lovelace', $5) RETURNING id`,
    [bookId, userId, uid, CARD_VCARD, `${uid}.vcf`],
  );
  return result.rows[0].id;
}

async function latestOperation(): Promise<{ status: string; resource_type: string; operation: string } | undefined> {
  const result = await query<{ status: string; resource_type: string; operation: string }>(
    'SELECT status, resource_type, operation FROM provider_operations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId],
  );
  return result.rows[0];
}

describeOrSkip('external DAV write-back with PostgreSQL', () => {
  it('forwards a CalDAV create to the source, then projects it locally', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/calendar', 'if-none-match': '*' },
      body: EVENT_ICS,
    });
    expect(response.status).toBe(201);

    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.url).toBe('/calendars/sam/work/e1.ics');
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['if-match']).toBeUndefined();
    expect(put.headers.authorization).toBe(`Basic ${Buffer.from('sam:app-password').toString('base64')}`);
    expect(put.body).toContain('UID:e1');

    const stored = await query<{ uid: string; etag: string; dav_filename: string }>(
      'SELECT uid, etag, dav_filename FROM calendar_events WHERE calendar_id = $1',
      [calendarId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ uid: 'e1', dav_filename: 'e1.ics' });
    // The client keeps the local entity-tag for its next If-Match, so the answer carries the
    // stored projection's tag rather than the source's.
    expect(response.headers.get('etag')).toBe(`"${stored.rows[0].etag}"`);
    expect(await latestOperation()).toEqual({ status: 'committed', resource_type: 'calendar_event', operation: 'create' });
  });

  it('forwards the stored remote version as If-Match and records the new version on the link', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const { eventId, linkId } = await seedEventLink(calendarId, collectionUrl, { uid: 'e1', href: `${collectionUrl}e1.ics`, version: 'remote-1' });
    dav.putEtag = '"remote-2"';

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/calendar', 'if-match': '"local-1"' },
      body: EVENT_ICS.replace('SUMMARY:Planning', 'SUMMARY:Planning updated'),
    });
    expect(response.status).toBe(204);

    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.headers['if-match']).toBe('"remote-1"');
    const link = await query<{ remote_version: string; status: string }>('SELECT remote_version, status FROM remote_object_links WHERE id = $1', [linkId]);
    expect(link.rows[0]).toEqual({ remote_version: 'remote-2', status: 'active' });
    const event = await query<{ raw_ical: string }>('SELECT raw_ical FROM calendar_events WHERE id = $1', [eventId]);
    expect(event.rows[0].raw_ical).toContain('SUMMARY:Planning updated');
  });

  it('reads a source 412 as a stale local copy, leaving the row and the link untouched', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const { eventId, linkId } = await seedEventLink(calendarId, collectionUrl, { uid: 'e1', href: `${collectionUrl}e1.ics`, version: 'remote-1' });
    dav.putStatus = 412;

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT', headers: { ...headers(), 'content-type': 'text/calendar' }, body: EVENT_ICS.replace('SUMMARY:Planning', 'SUMMARY:Should not stick'),
    });
    expect(response.status).toBe(412);
    const event = await query<{ raw_ical: string }>('SELECT raw_ical FROM calendar_events WHERE id = $1', [eventId]);
    expect(event.rows[0].raw_ical).toBe(EVENT_ICS);
    const link = await query<{ remote_version: string }>('SELECT remote_version FROM remote_object_links WHERE id = $1', [linkId]);
    expect(link.rows[0].remote_version).toBe('remote-1');
    expect(await latestOperation()).toEqual({ status: 'conflict', resource_type: 'calendar_event', operation: 'update' });
  });

  it('parks an ambiguous source failure as outcome_unknown and touches nothing', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const { eventId } = await seedEventLink(calendarId, collectionUrl, { uid: 'e1', href: `${collectionUrl}e1.ics`, version: 'remote-1' });
    dav.putStatus = 500;

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT', headers: { ...headers(), 'content-type': 'text/calendar' }, body: EVENT_ICS.replace('SUMMARY:Planning', 'SUMMARY:Should not stick'),
    });
    expect(response.status).toBe(502);
    const event = await query<{ raw_ical: string }>('SELECT raw_ical FROM calendar_events WHERE id = $1', [eventId]);
    expect(event.rows[0].raw_ical).toBe(EVENT_ICS);
    expect(await latestOperation()).toEqual({ status: 'outcome_unknown', resource_type: 'calendar_event', operation: 'update' });
  });

  it('deletes locally only after the source confirms, and tombstones the link', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const { eventId, linkId } = await seedEventLink(calendarId, collectionUrl, { uid: 'e1', href: `${collectionUrl}e1.ics`, version: 'remote-1' });

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'DELETE', headers: { ...headers(), 'if-match': '"local-1"' },
    });
    expect(response.status).toBe(204);
    const del = dav.requests.find(request => request.method === 'DELETE');
    if (!del) throw new Error('the source did not receive the DELETE');
    expect(del.headers['if-match']).toBe('"remote-1"');
    const events = await query('SELECT id FROM calendar_events WHERE id = $1', [eventId]);
    expect(events.rows).toHaveLength(0);
    const link = await query<{ status: string; local_id: string | null }>('SELECT status, local_id FROM remote_object_links WHERE id = $1', [linkId]);
    expect(link.rows[0]).toEqual({ status: 'deleted', local_id: null });
    expect(await latestOperation()).toEqual({ status: 'committed', resource_type: 'calendar_event', operation: 'delete' });
  });

  it('treats a source that no longer lists the event as already gone, without sending DELETE', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    const event = await query<{ id: string }>(
      `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, dav_filename)
       VALUES ($1, $2, 'e1', $3, 'local-1', 'Planning', NOW(), NOW() + interval '1 hour', 'e1.ics') RETURNING id`,
      [calendarId, userId, EVENT_ICS],
    );
    dav.caldavReport = emptyMultistatus;

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'DELETE', headers: { ...headers(), 'if-match': '"local-1"' },
    });
    expect(response.status).toBe(204);
    expect(dav.requests.some(request => request.method === 'DELETE')).toBe(false);
    expect((await query('SELECT id FROM calendar_events WHERE id = $1', [event.rows[0].id])).rows).toHaveLength(0);
  });

  it('forwards a CardDAV create to the source and projects the contact locally', async () => {
    const collectionUrl = `${sourceBase}/books/sam/personal/`;
    const bookId = await seedCarddavBook(collectionUrl);
    const response = await fetch(`${davBase}/carddav/${userId}/${bookId}/c1.vcf`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/vcard', 'if-none-match': '*' },
      body: CARD_VCARD,
    });
    expect(response.status).toBe(201);
    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.url).toBe('/books/sam/personal/c1.vcf');
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers.authorization).toBe(`Basic ${Buffer.from('sam:app-password').toString('base64')}`);
    const contact = await query<{ uid: string; display_name: string; dav_filename: string; primary_email: string }>(
      'SELECT uid, display_name, dav_filename, primary_email FROM contacts WHERE address_book_id = $1',
      [bookId],
    );
    expect(contact.rows[0]).toMatchObject({ uid: 'c1', display_name: 'Ada Lovelace', dav_filename: 'c1.vcf', primary_email: 'ada@example.test' });
    expect(await latestOperation()).toEqual({ status: 'committed', resource_type: 'contact', operation: 'create' });
  });

  it('forwards the stored CardDAV version as If-Match on an update', async () => {
    const collectionUrl = `${sourceBase}/books/sam/personal/`;
    const bookId = await seedCarddavBook(collectionUrl);
    const contactId = await seedContact(bookId, 'c1');
    await query(
      `INSERT INTO remote_object_links (user_id, collection_id, object_type, local_id, collection_remote_id, object_remote_id, remote_href, remote_version, status)
       SELECT $1, ic.id, 'contact', $2, $3, 'c1', $4, 'card-1', 'active' FROM integration_collections ic
        WHERE ic.local_address_book_id = $5 LIMIT 1`,
      [userId, contactId, collectionUrl, `${collectionUrl}c1.vcf`, bookId],
    );
    dav.putEtag = '"card-2"';

    const response = await fetch(`${davBase}/carddav/${userId}/${bookId}/c1.vcf`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/vcard', 'if-match': '"local-1"' },
      body: CARD_VCARD.replace('FN:Ada Lovelace', 'FN:Ada Byron'),
    });
    expect(response.status).toBe(204);
    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.headers['if-match']).toBe('"card-1"');
    const contact = await query<{ display_name: string }>('SELECT display_name FROM contacts WHERE id = $1', [contactId]);
    expect(contact.rows[0].display_name).toBe('Ada Byron');
  });

  it('refuses a write it cannot guard when the source no longer lists the object', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    await query(
      `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, dav_filename)
       VALUES ($1, $2, 'e1', $3, 'local-1', 'Planning', NOW(), NOW() + interval '1 hour', 'e1.ics')`,
      [calendarId, userId, EVENT_ICS],
    );
    dav.caldavReport = emptyMultistatus;

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT', headers: { ...headers(), 'content-type': 'text/calendar' }, body: EVENT_ICS,
    });
    expect(response.status).toBe(412);
    expect(dav.requests.some(request => request.method === 'PUT')).toBe(false);
  });

  it('resolves a CalDAV resource the link table does not know, then guards the write with its version', async () => {
    const collectionUrl = `${sourceBase}/calendars/sam/work/`;
    const calendarId = await seedCaldavCalendar(collectionUrl);
    await query(
      `INSERT INTO calendar_events (calendar_id, user_id, uid, raw_ical, etag, summary, starts_at, ends_at, dav_filename)
       VALUES ($1, $2, 'e1', $3, 'local-1', 'Planning', NOW(), NOW() + interval '1 hour', 'e1.ics')`,
      [calendarId, userId, EVENT_ICS],
    );
    // The source stores the resource under a name the client never chose; only a UID match finds it.
    dav.caldavReport = caldavReport('/calendars/sam/work/remote-path.ics', 'remote-9', EVENT_ICS);
    dav.putEtag = '"remote-10"';

    const response = await fetch(`${davBase}/caldav/${userId}/${calendarId}/e1.ics`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/calendar' },
      body: EVENT_ICS.replace('SUMMARY:Planning', 'SUMMARY:Resolved'),
    });
    expect(response.status).toBe(204);
    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.url).toBe('/calendars/sam/work/remote-path.ics');
    expect(put.headers['if-match']).toBe('"remote-9"');
  });

  it('resolves a CardDAV card the link table does not know, then guards the write with its version', async () => {
    const collectionUrl = `${sourceBase}/books/sam/personal/`;
    const bookId = await seedCarddavBook(collectionUrl);
    await seedContact(bookId, 'c1');
    dav.carddavReport = carddavReport('/books/sam/personal/remote-card.vcf', 'card-9', CARD_VCARD);
    dav.putEtag = '"card-10"';

    const response = await fetch(`${davBase}/carddav/${userId}/${bookId}/c1.vcf`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'text/vcard', 'if-match': '"local-1"' },
      body: CARD_VCARD.replace('FN:Ada Lovelace', 'FN:Ada Byron'),
    });
    expect(response.status).toBe(204);
    const put = dav.requests.find(request => request.method === 'PUT');
    if (!put) throw new Error('the source did not receive the PUT');
    expect(put.url).toBe('/books/sam/personal/remote-card.vcf');
    expect(put.headers['if-match']).toBe('"card-9"');
  });
});
