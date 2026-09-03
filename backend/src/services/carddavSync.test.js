import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, discoverAddressBooks, fetchAddressBookCards, getConnectionPolicy } = vi.hoisted(() => ({
  query: vi.fn(), discoverAddressBooks: vi.fn(), fetchAddressBookCards: vi.fn(), getConnectionPolicy: vi.fn(),
}));
vi.mock('./db.js', () => ({ query }));
vi.mock('./carddavClient.js', () => ({ discoverAddressBooks, fetchAddressBookCards }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('./encryption.js', () => ({ decrypt: value => value }));

import { syncUser } from './carddavSync.js';

const appleCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:apple-1\r\nFN:Apple Contact\r\nPHOTO;TYPE=JPEG:YWJj\r\nX-ABDATE;TYPE=Wedding:2020-09-14\r\nX-ABDATE;TYPE=Wedding:20200914\r\nEND:VCARD\r\n';
const androidCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:android-1\r\nFN:Android Contact\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2019-10-19;0;Rencontre;\r\nEND:VCARD\r\n';
const appleMergeCard = appleCard.replace('FN:Apple Contact\r\n', 'FN:Apple Contact\r\nEMAIL:duplicate@example.com\r\nBDAY:1990-01-02\r\nANNIVERSARY:2020-09-14\r\n');
const androidMergeCard = androidCard.replace('FN:Android Contact\r\n', 'FN:Android Contact\r\nEMAIL:duplicate@example.com\r\nBDAY:1991-02-03\r\nANNIVERSARY:2021-10-19\r\n');
const invalidBirthdayCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:invalid-birthday\r\nFN:Invalid Birthday\r\nBDAY:2020-02-30\r\nEND:VCARD\r\n';
const invalidAndroidDateCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:invalid-android-date\r\nFN:Invalid Android Date\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2024-04-31;0;Meeting;\r\nEND:VCARD\r\n';

function configureSync() {
  query.mockImplementation(async sql => {
    if (sql.includes('SELECT config FROM user_integrations')) return { rows: [{ config: { serverUrl: 'https://dav.example', username: 'user', password: 'password' } }] };
    if (sql.includes('SELECT id FROM address_books')) return { rows: [{ id: 'book-1' }] };
    return { rows: [] };
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
  discoverAddressBooks.mockResolvedValue([{ url: 'https://dav.example/contacts', displayName: 'Contacts' }]);
  fetchAddressBookCards.mockResolvedValue([
    { href: '/apple.vcf', vcard: appleCard },
    { href: '/android.vcf', vcard: androidCard },
  ]);
}

describe('remote CardDAV contact-date persistence', () => {
  beforeEach(() => {
    query.mockReset(); discoverAddressBooks.mockReset(); fetchAddressBookCards.mockReset(); getConnectionPolicy.mockReset();
    configureSync();
  });

  it('binds Apple and Android labelled dates to contact_dates and updates them idempotently', async () => {
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 2 });

    const upserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(upserts).toHaveLength(2);
    for (const [sql, params] of upserts) {
      expect(sql).toContain('anniversary, contact_dates, photo_data');
      expect(sql).toContain('$16::jsonb,$17,$18,$19,$20,$21::jsonb');
      expect(sql).toContain('contact_dates = EXCLUDED.contact_dates');
      expect(JSON.parse(params[15])).toEqual([
        params[2] === 'apple-1' ? { label: 'Wedding', value: '2020-09-14' } : { label: 'Rencontre', value: '2019-10-19' },
      ]);
      expect(params[2]).toMatch(/^(apple|android)-1$/);
      expect(params[3]).toMatch(/^BEGIN:VCARD/);
      expect(params[4]).toMatch(/^[a-f0-9]{32}$/);
      expect(params[16]).toBe(params[2] === 'apple-1' ? 'data:image/jpeg;base64,YWJj' : null);
    }

    query.mockClear();
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 2 });
    const secondUpserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(secondUpserts.map(([, params]) => params[15])).toEqual(upserts.map(([, params]) => params[15]));
  });

  it.each([
    ['Apple', '/apple.vcf', appleMergeCard, [
      { label: 'Birthday', value: '1990-01-02' }, { label: 'Anniversary', value: '2020-09-14' }, { label: 'Wedding', value: '2020-09-14' },
    ]],
    ['Android', '/android.vcf', androidMergeCard, [
      { label: 'Birthday', value: '1991-02-03' }, { label: 'Anniversary', value: '2021-10-19' }, { label: 'Rencontre', value: '2019-10-19' },
    ]],
  ])('merges %s labelled dates into an existing matching-email contact idempotently', async (_source, href, vcard, contactDates) => {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT config FROM user_integrations')) return { rows: [{ config: { serverUrl: 'https://dav.example', username: 'user', password: 'password', dupMode: 'merge' } }] };
      if (sql.includes('SELECT id FROM address_books')) return { rows: [{ id: 'book-1' }] };
      if (sql.includes('SELECT id, primary_email FROM contacts')) return { rows: [{ id: 'existing-contact-1', primary_email: 'duplicate@example.com' }] };
      return { rows: [] };
    });
    fetchAddressBookCards.mockResolvedValue([{ href, vcard }]);

    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 0 });
    const [mergeSql, mergeParams] = query.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));

    expect(mergeSql).toContain('contact_dates = $10::jsonb');
    expect(mergeSql).toContain('photo_data = COALESCE($11, photo_data)');
    expect(mergeSql).toContain('urls = $15::jsonb, instant_messages = $16::jsonb, categories = $17::jsonb, addresses = $18::jsonb');
    expect(mergeSql).not.toContain('primary_email =');
    expect(mergeParams[0]).toBe('existing-contact-1');
    expect(mergeParams[1]).toBe('Apple Contact'.replace('Apple', _source));
    expect(mergeParams[2]).toBeNull();
    expect(mergeParams[3]).toBeNull();
    expect(mergeParams[7]).toBe(_source === 'Apple' ? '1990-01-02' : '1991-02-03');
    expect(mergeParams[8]).toBe(_source === 'Apple' ? '2020-09-14' : '2021-10-19');
    expect(JSON.parse(mergeParams[9])).toEqual(contactDates);
    expect(mergeParams[10]).toBe(_source === 'Apple' ? 'data:image/jpeg;base64,YWJj' : null);
    expect(mergeParams.slice(14, 18)).toEqual(['[]', '[]', '[]', '[]']);
    expect(mergeParams[18]).toBe(vcard);
    expect(mergeParams[19]).toBe(crypto.createHash('md5').update(vcard).digest('hex'));

    query.mockClear();
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 0 });
    const [, secondMergeParams] = query.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    expect(secondMergeParams[9]).toBe(mergeParams[9]);
  });

  it.each([
    ['birthday', invalidBirthdayCard],
    ['Android labelled date', invalidAndroidDateCard],
  ])('rejects a remote vCard with an invalid %s before address-book or contact writes', async (_source, vcard) => {
    fetchAddressBookCards.mockResolvedValue([{ href: '/invalid.vcf', vcard }]);

    await expect(syncUser('user-1')).resolves.toMatchObject({
      ok: false,
      error: 'Remote CardDAV vCard contains an invalid contact date',
    });

    const postConfigQueries = query.mock.calls.slice(1);
    expect(postConfigQueries).toHaveLength(1);
    expect(postConfigQueries[0][0]).toContain('UPDATE user_integrations SET config');
  });
});
