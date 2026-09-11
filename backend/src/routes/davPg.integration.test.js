// Real PostgreSQL + real DAV HTTP handlers. Authentication is synthetic; no external server or mail is contacted.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import express from 'express';
import 'express-async-errors';
import { pool, query } from '../services/db.js';
const auth = vi.hoisted(() => ({ userId: null }));
vi.mock('../services/davCredentials.js', () => ({ authenticateDavCredential: async () => auth }));
vi.mock('../services/rateLimiter.js', () => ({ consume: async () => ({ limited: false }) }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: () => {} }));
import carddav from './carddav.js';
import caldav from './caldav.js';
const enabled = process.env.REQUIRE_DAV_POSTGRES === '1';
describe.skipIf(!enabled)('DAV HTTP with PostgreSQL migrations', () => {
  let server, base, book, calendar;
  const headers = { authorization: `Basic ${Buffer.from('synthetic:dav-test').toString('base64')}` };
  const report = token => `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token || ''}</D:sync-token></D:sync-collection>`;
  beforeAll(async () => {
    auth.userId = randomUUID();
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [auth.userId, `dav-test-${auth.userId}`, 'unused']);
    book = (await query("INSERT INTO address_books(user_id, name, source) VALUES($1,'DAV regression','local') RETURNING id", [auth.userId])).rows[0].id;
    calendar = (await query("INSERT INTO calendars(user_id, owner_user_id, name) VALUES($1,$1,'DAV regression') RETURNING id", [auth.userId])).rows[0].id;
    const app = express(); app.use('/carddav', carddav); app.use('/caldav', caldav);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (auth.userId) await query('DELETE FROM users WHERE id=$1', [auth.userId]);
    await pool.end();
  });
  it('round trips independent CardDAV filenames, rich fields, ETags, updates and deletion deltas', async () => {
    const collection = `${base}/carddav/${auth.userId}/${book}/`;
    const url = `${collection}client-generated.vcf`;
    const body = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:embedded-contact\r\nFN:Ada\r\nTITLE:Engineer\r\nROLE:Research\r\nEMAIL;TYPE=PREF:ada@example.test\r\nADR;TYPE=WORK:;;Main Street;London;;123;UK\r\nEND:VCARD\r\n';
    const created = await fetch(url, { method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body });
    expect(created.status).toBe(201);
    const get = await fetch(url, { headers }); expect(await get.text()).toBe(body);
    const row = (await query('SELECT * FROM contacts WHERE address_book_id=$1', [book])).rows[0];
    expect(row).toMatchObject({ uid: 'embedded-contact', title: 'Engineer', role: 'Research', primary_email: 'ada@example.test', dav_filename: 'client-generated.vcf' });
    expect(row.addresses).toHaveLength(1);
    const initial = await (await fetch(collection, { method: 'REPORT', headers, body: report() })).text();
    const token = initial.match(/<D:sync-token>([^<]+)</)[1];
    expect((await fetch(url, { method: 'PUT', headers: { ...headers, 'if-match': '"stale"' }, body })).status).toBe(412);
    const updated = await fetch(url, { method: 'PUT', headers: { ...headers, 'if-match': get.headers.get('etag') }, body: body.replace('FN:Ada', 'FN:Ada Lovelace') });
    expect(updated.status).toBe(204);
    expect((await fetch(url, { method: 'DELETE', headers: { ...headers, 'if-match': updated.headers.get('etag') } })).status).toBe(204);
    const delta = await (await fetch(collection, { method: 'REPORT', headers, body: report(token) })).text();
    expect(delta).toContain('client-generated.vcf</D:href><D:status>HTTP/1.1 404 Not Found');
    expect((await fetch(url, { headers })).status).toBe(404);
  });
  it('round trips CalDAV metadata and protects concurrent updates with the actual database ETag', async () => {
    const url = `${base}/caldav/${auth.userId}/${calendar}/client-generated.ics`;
    const body = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:embedded-event\r\nDTSTART:20260911T090000Z\r\nDTEND:20260911T100000Z\r\nSUMMARY:Planning\r\nDESCRIPTION:Visible details\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const created = await fetch(url, { method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body });
    expect(created.status).toBe(201);
    expect(await (await fetch(url, { headers })).text()).toContain('DESCRIPTION:Visible details');
    expect((await query('SELECT description, location FROM calendar_events WHERE calendar_id=$1', [calendar])).rows[0]).toEqual({ description: 'Visible details', location: 'Room 1' });
    const updates = await Promise.all([1, 2].map(n => fetch(url, { method: 'PUT', headers: { ...headers, 'if-match': created.headers.get('etag') }, body: body.replace('SUMMARY:Planning', `SUMMARY:Planning ${n}`) })));
    expect(updates.map(result => result.status).sort()).toEqual([204, 412]);
    const current = await fetch(url, { headers });
    expect((await fetch(url, { method: 'DELETE', headers: { ...headers, 'if-match': current.headers.get('etag') } })).status).toBe(204);
    expect((await query('SELECT deleted, dav_filename FROM calendar_sync_changes WHERE calendar_id=$1 ORDER BY version DESC LIMIT 1', [calendar])).rows[0]).toEqual({ deleted: true, dav_filename: 'client-generated.ics' });
  });
});
