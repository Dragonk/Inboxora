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
});
