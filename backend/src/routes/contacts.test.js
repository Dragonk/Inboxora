import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query }));

import express from 'express';
import session from 'express-session';
import contactsRouter from './contacts.js';

const existingVCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:contact-1',
  'FN:Ada',
  'BDAY;TYPE=Birthday:1990-01-02',
  'X-ABDATE;TYPE=Wedding:2020-09-14',
  'ANNIVERSARY;TYPE=Anniversary:2021-05-06',
  'END:VCARD',
].join('\r\n') + '\r\n';

const updatedContact = {
  id: 'contact-1', uid: 'contact-1', display_name: 'Ada',
  emails: [], phones: [], contactDates: [], birthday: null, anniversary: null,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = 'user-1'; next(); });
  app.use('/api/contacts', contactsRouter);
  return app;
}

function arrangeQuery(contact, result = updatedContact) {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    .mockResolvedValueOnce({ rows: [{
      id: 'contact-1', uid: 'contact-1', display_name: 'Ada', first_name: null, last_name: null,
      primary_email: null, emails: [], phones: [], organization: null, notes: null,
      birthday: '1990-01-02', anniversary: '2021-05-06', contact_dates: contact,
      title: null, role: null, nickname: null, urls: [], instant_messages: [], categories: [], addresses: [],
      vcard: existingVCard, book_source: 'local', address_book_id: 'book-1',
    }] })
    .mockResolvedValueOnce({ rows: [result] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  query.mockReset();
});

describe('Contact REST PATCH legacy date synchronization', () => {
  it('clearing birthday removes its legacy labelled date while preserving custom dates', async () => {
    arrangeQuery([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Wedding', value: '2020-09-14' },
      { label: 'Anniversary', value: '2021-05-06' },
    ], { ...updatedContact, contactDates: [{ label: 'Wedding', value: '2020-09-14' }] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ birthday: null }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    expect(update[1][8]).toBeNull();
    expect(JSON.parse(update[1][10])).toEqual([
      { label: 'Wedding', value: '2020-09-14' },
      { label: 'Anniversary', value: '2021-05-06' },
    ]);
    expect(update[1][18]).not.toContain('BDAY');
    expect(update[1][18]).toContain('ANNIVERSARY;TYPE=Anniversary:2021-05-06');
    expect(update[1][18]).toContain('X-ABDATE;TYPE=Wedding:2020-09-14');
  });

  it('changing anniversary replaces its old legacy labelled date with exactly one new date', async () => {
    arrangeQuery([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Anniversary', value: '2021-05-06' },
    ], { ...updatedContact, birthday: '1990-01-02', anniversary: '2022-06-07', contactDates: [
      { label: 'Birthday', value: '1990-01-02' }, { label: 'Anniversary', value: '2022-06-07' },
    ] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anniversary: '2022-06-07' }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    const dates = JSON.parse(update[1][10]);
    expect(dates).toEqual([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Anniversary', value: '2022-06-07' },
    ]);
    expect(update[1][18].match(/ANNIVERSARY/g)).toHaveLength(1);
    expect(update[1][18]).toContain('ANNIVERSARY;TYPE=Anniversary:2022-06-07');
    expect(update[1][18]).not.toContain('2021-05-06');
  });

  it('keeps explicitly supplied contactDates authoritative when legacy fields are also supplied', async () => {
    arrangeQuery([{ label: 'Birthday', value: '1990-01-02' }], {
      ...updatedContact, birthday: '1991-01-02', contactDates: [{ label: 'Birthday', value: '1990-01-02' }],
    });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ birthday: '1991-01-02', contactDates: [{ label: 'Birthday', value: '1990-01-02' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    expect(JSON.parse(update[1][10])).toEqual([{ label: 'Birthday', value: '1990-01-02' }]);
    expect(update[1][18].match(/BDAY/g)).toHaveLength(1);
    expect(update[1][18]).toContain('BDAY;TYPE=Birthday:1990-01-02');
    expect(update[1][18]).not.toContain('1991-01-02');
  });
});

describe('Contact REST labelled date validation', () => {
  it.each([
    ['Family\r\nX-Evil: injected'],
    ['Family"Other'],
  ])('rejects unsafe labelled dates on POST before any write query: %s', async label => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada', contactDates: [{ label, value: '2020-09-14' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD dates' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT id FROM users');
  });

  it.each([
    ['Family\r\nX-Evil: injected'],
    ['Family"Other'],
  ])('rejects unsafe labelled dates on PATCH before loading or writing: %s', async label => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactDates: [{ label, value: '2020-09-14' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD dates' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT id FROM users');
  });

  it('stores colon and semicolon labels exactly once and serializes them losslessly', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1' }] })
      .mockResolvedValueOnce({ rows: [{ ...updatedContact, contactDates: [
        { label: 'Family:Other', value: '2020-09-14' },
        { label: 'Family;Other', value: '2021-05-06' },
      ] }] })
      .mockResolvedValueOnce({ rows: [] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada', contactDates: [
        { label: 'Family:Other', value: '2020-09-14' },
        { label: 'Family;Other', value: '2021-05-06' },
        { label: 'Family:Other', value: '2020-09-14' },
      ] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(201);
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(JSON.parse(insert[1][15])).toEqual([
      { label: 'Family:Other', value: '2020-09-14' },
      { label: 'Family;Other', value: '2021-05-06' },
    ]);
    expect(insert[1][3]).toContain('X-ABDATE;TYPE="Family:Other":2020-09-14');
    expect(insert[1][3]).toContain('X-ABDATE;TYPE="Family;Other":2021-05-06');
  });
});
