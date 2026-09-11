import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCors } from '../middleware/browserCors.js';

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
  app.use(createBrowserCors({ origin: 'https://email.kmms.ovh', credentials: true }));
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
    expect(response.headers.get('dav')).toContain('addressbook');
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

  it('discovers every provisioned address book for a DAV client', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [
      { id: 'personal-contacts', name: 'Prywatne', sync_token: 'sync-private' },
      { id: 'work-contacts', name: 'Służbowe', sync_token: 'sync-work' },
    ] });

    const response = await fetch(`${base}/carddav/user-1/`, {
      method: 'PROPFIND',
      headers: { authorization: basic('sam@example.test', 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456'), depth: '1' },
    });

    expect(response.status).toBe(207);
    const xml = await response.text();
    expect(xml).toContain('/carddav/user-1/personal-contacts/');
    expect(xml).toContain('/carddav/user-1/work-contacts/');
    expect(query).toHaveBeenCalledWith(
      'SELECT id, name, sync_token, sync_version FROM address_books WHERE user_id = $1 ORDER BY created_at',
      ['user-1'],
    );
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

  it('maps all local CardDAV create date and photo columns by position', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'mf_dav_123e4567-e89b-12d3-a456-426614174000.exampleSecret-123456'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nBDAY:1990-01-02\r\nANNIVERSARY:2020-09-14\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2019-10-19;0;Rencontre;\r\nPHOTO;ENCODING=b;TYPE=PNG:AQI=\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([statement]) => statement.includes('INSERT INTO contacts'));
    expect(sql.match(/VALUES ([^\n]+)/)?.[1]).toBe('($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,$25, false)');
    expect(params).toEqual([
      'book-1', 'user-1', 'contact-1', expect.any(String), expect.any(String),
      'Ada', null, null, null, '[]', '[]', null, null,
      '1990-01-02', '2020-09-14',
      JSON.stringify([
        { label: 'Birthday', value: '1990-01-02' },
        { label: 'Anniversary', value: '2020-09-14' },
        { label: 'Rencontre', value: '2019-10-19' },
      ]),
      'data:image/png;base64,AQI=', null, null, null, '[]', '[]', '[]', '[]', 'contact-1.vcf',
    ]);
  });

  it('rejects an impossible BDAY before querying the address book', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'dav-password'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nBDAY:2020-02-30\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsafe quoted labelled-date parameters before querying the address book', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: { authorization: basic('sam@example.test', 'dav-password'), 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nX-ABDATE;TYPE="Family\\"Other":2020-09-14\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects raw line breaks inside quoted labelled-date parameters before querying the address book', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: { authorization: basic('sam@example.test', 'dav-password'), 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nX-ABDATE;TYPE="Family\r\nX-Evil: injected":2020-09-14\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('persists valid Android labelled dates on a local CardDAV write', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'dav-password'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2019-10-19;0;Rencontre;\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([statement]) => statement.includes('INSERT INTO contacts'));
    expect(sql).toContain('contact_dates');
    expect(params).toContain(JSON.stringify([{ label: 'Rencontre', value: '2019-10-19' }]));
  });

  it('persists semicolons in labelled dates on a local CardDAV write', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'dav-password'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nX-ABDATE;TYPE="Family;Other":2020-09-14\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([statement]) => statement.includes('INSERT INTO contacts'));
    expect(sql).toContain('contact_dates');
    expect(params).toContain(JSON.stringify([{ label: 'Family;Other', value: '2020-09-14' }]));
  });

  it('rejects replacing an existing DAV path with a different UID', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] }).mockResolvedValueOnce({ rows: [{ uid: 'path-a', dav_filename: 'path-a.vcf', etag: 'old' }] });
    const response = await fetch(`${base}/carddav/user-1/book-1/path-a.vcf`, {
      method: 'PUT',
      headers: { authorization: `Basic ${Buffer.from('sam@example.test:secret').toString('base64')}`, 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:path-b\r\nFN:Ada\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(409);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO contacts|UPDATE contacts/.test(sql))).toBe(false);
  });

  it('rejects an impossible BDAY before querying the address book', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'dav-password'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nBDAY:2020-02-30\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('persists valid Android labelled dates on a local CardDAV write', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/carddav/user-1/book-1/contact-1.vcf`, {
      method: 'PUT',
      headers: {
        authorization: basic('sam@example.test', 'dav-password'),
        'content-type': 'text/vcard',
      },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2019-10-19;0;Rencontre;\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(201);
    const [sql, params] = query.mock.calls.find(([statement]) => statement.includes('INSERT INTO contacts'));
    expect(sql).toContain('contact_dates');
    expect(params).toContain(JSON.stringify([{ label: 'Rencontre', value: '2019-10-19' }]));
  });

  it('rejects replacing an existing DAV path with a different UID', async () => {
    authenticateDavCredential.mockResolvedValue({ userId: 'user-1', credentialId: 'credential-1' });
    query.mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] }).mockResolvedValueOnce({ rows: [{ uid: 'path-a', dav_filename: 'path-a.vcf', etag: 'old' }] });
    const response = await fetch(`${base}/carddav/user-1/book-1/path-a.vcf`, {
      method: 'PUT',
      headers: { authorization: `Basic ${Buffer.from('sam@example.test:secret').toString('base64')}`, 'content-type': 'text/vcard' },
      body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:path-b\r\nFN:Ada\r\nEND:VCARD\r\n',
    });

    expect(response.status).toBe(409);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO contacts|UPDATE contacts/.test(sql))).toBe(false);
  });
});

it('accepts a client chosen filename and maps every rich field and preferred email', async () => {
 authenticateDavCredential.mockResolvedValue({ userId: 'user-1' });
 query.mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] }).mockResolvedValueOnce({ rows: [] });
 const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:embedded-uid', 'FN:Ada', 'EMAIL;TYPE=HOME:home@example.test', 'EMAIL;TYPE=WORK,PREF:work@example.test', 'TITLE:Director', 'ROLE:Design', 'NICKNAME:A', 'URL:https://example.test', 'IMPP:matrix:ada@example.test', 'CATEGORIES:Team', 'ADR;TYPE=WORK:;;Main Street;Warsaw;;;Poland', 'END:VCARD'].join('\r\n');
 const response = await fetch(`${base}/carddav/user-1/book-1/client-generated.vcf`, { method: 'PUT', headers: { authorization: basic('sam@example.test','secret'), 'if-none-match': '*' }, body: raw });
 expect(response.status).toBe(201);
 const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO contacts'));
 expect(insert[1][2]).toBe('embedded-uid'); expect(insert[1][8]).toBe('work@example.test');
 expect(insert[1].slice(17,20)).toEqual(['Director','Design','A']);
 expect(insert[1].at(-1)).toBe('client-generated.vcf');
 expect(insert[0]).toContain('instant_messages, categories, addresses, dav_filename');
});
it('enforces create-only and update-only CardDAV preconditions before modifying a contact', async () => {
 authenticateDavCredential.mockResolvedValue({ userId: 'user-1' });
 for (const [headers, rows] of [[{ 'if-none-match': '*' }, [{ id: 'contact', uid: 'same', etag: 'old' }]], [{ 'if-match': '"missing"' }, []]]) {
  query.mockReset(); query.mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local' }] }).mockResolvedValueOnce({ rows });
  const response = await fetch(`${base}/carddav/user-1/book-1/same.vcf`, { method: 'PUT', headers: { authorization: basic('sam@example.test','secret'), ...headers }, body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:same\r\nFN:Ada\r\nEND:VCARD' });
  expect(response.status).toBe(412); expect(query.mock.calls).toHaveLength(2);
 }
});

it('returns CardDAV deltas with deletion tombstones and a collection-scoped token', async () => {
  authenticateDavCredential.mockResolvedValue({ userId: 'user-1' });
  query.mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_version: '7' }] })
    .mockResolvedValueOnce({ rows: [{ dav_filename: 'removed.vcf', deleted: true }] });
  const result = await fetch(`${base}/carddav/user-1/book-1/`, {
    method: 'REPORT', headers: { authorization: basic('test', 'dav-password') },
    body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token>urn:inboxora:carddav:book-1:5</D:sync-token></D:sync-collection>',
  });
  expect(result.status).toBe(207);
  const xml = await result.text();
  expect(xml).toContain('<D:href>/carddav/user-1/book-1/removed.vcf</D:href><D:status>HTTP/1.1 404 Not Found</D:status>');
  expect(xml).toContain('urn:inboxora:carddav:book-1:7');
  expect(query.mock.calls[1][1]).toEqual(['book-1', 5, '7']);
});

it('rejects an old or foreign CardDAV token instead of silently missing deletions', async () => {
  authenticateDavCredential.mockResolvedValue({ userId: 'user-1' });
  query.mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_version: 7 }] });
  const result = await fetch(`${base}/carddav/user-1/book-1/`, {
    method: 'REPORT', headers: { authorization: basic('test', 'dav-password') },
    body: '<D:sync-collection xmlns:D="DAV:"><D:sync-token>legacy-random-token</D:sync-token></D:sync-collection>',
  });
  expect(result.status).toBe(409);
  expect(await result.text()).toContain('valid-sync-token');
  expect(query).toHaveBeenCalledTimes(1);
});

it('limits CardDAV multiget to requested filenames and reports missing resources', async () => {
  authenticateDavCredential.mockResolvedValue({ userId: 'user-1' });
  query.mockResolvedValueOnce({ rows: [{ id: 'book-1' }] }).mockResolvedValueOnce({ rows: [{ uid: 'embedded-uid', dav_filename: 'ada lovelace.vcf', etag: 'a', vcard: 'FN:Ada' }] });
  const result = await fetch(`${base}/carddav/user-1/book-1/`, {
    method: 'REPORT', headers: { authorization: basic('test', 'dav-password') },
    body: '<C:addressbook-multiget xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:D="DAV:"><D:href>/carddav/user-1/book-1/ada%20lovelace.vcf</D:href><D:href>/carddav/user-1/book-1/missing.vcf</D:href></C:addressbook-multiget>',
  });
  expect(result.status).toBe(207);
  expect(query.mock.calls[1][1]).toEqual(['book-1', ['ada lovelace.vcf', 'missing.vcf']]);
  const xml = await result.text();
  expect(xml).toContain('FN:Ada');
  expect(xml).toContain('<D:href>/carddav/user-1/book-1/missing.vcf</D:href><D:status>HTTP/1.1 404 Not Found</D:status>');
});
