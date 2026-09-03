import { describe, expect, it } from 'vitest';
import { generateVCard, mergeVCard, normalizeContactDateLabel, parseVCard } from './vcard.js';

describe('vCard contact dates', () => {
  it('round-trips multiple labelled contact dates', () => {
    const source = {
      uid: 'contact-dates-1', displayName: 'Ada',
      contactDates: [
        { label: 'Birthday', value: '1990-01-02' },
        { label: 'Wedding', value: '2020-09-14' },
        { label: 'Custom, Date', value: '2024-12-31' },
      ],
    };

    const raw = generateVCard(source);
    expect(raw).toContain('BDAY;TYPE=Birthday:1990-01-02');
    expect(raw).toContain('X-ABDATE;TYPE=Wedding:2020-09-14');
    expect(parseVCard(raw).contactDates).toEqual(source.contactDates);
  });

  it('deduplicates repeated labelled dates while accepting Android custom events', () => {
    const parsed = parseVCard([
      'BEGIN:VCARD', 'VERSION:3.0',
      'BDAY:19900102', 'BDAY:1990-01-02',
      'X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;1990-01-02;0;Birthday;',
      'X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;20200914;1;Graduation;',
      'END:VCARD',
    ].join('\r\n'));

    expect(parsed.contactDates).toEqual([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Graduation', value: '2020-09-14' },
    ]);
  });

  it('associates grouped Apple labels with contact dates case-insensitively', () => {
    const parsed = parseVCard([
      'BEGIN:VCARD', 'VERSION:3.0',
      'ITEM1.X-ABDATE:20200914', 'item1.X-ABLabel:Wedding',
      'END:VCARD',
    ].join('\r\n'));

    expect(parsed.contactDates).toEqual([{ label: 'Wedding', value: '2020-09-14' }]);
  });

  it('preserves colons inside quoted Apple date labels', () => {
    const parsed = parseVCard([
      'BEGIN:VCARD', 'VERSION:3.0',
      'X-ABDATE;TYPE="Family:Other":20200914',
      'END:VCARD',
    ].join('\r\n'));

    expect(parsed.contactDates).toEqual([{ label: 'Family:Other', value: '2020-09-14' }]);
  });

  it('round-trips semicolons in labelled contact-date parameters', () => {
    const source = {
      uid: 'contact-semicolon-1', displayName: 'Ada',
      contactDates: [{ label: 'Family;Other', value: '2020-09-14' }],
    };
    const raw = generateVCard(source);

    expect(raw).toContain('X-ABDATE;TYPE="Family;Other":2020-09-14');
    expect(parseVCard(raw).contactDates).toEqual(source.contactDates);
    expect(generateVCard(parseVCard(raw))).toContain('X-ABDATE;TYPE="Family;Other":2020-09-14');
  });

  it('preserves colon and semicolon labels while rejecting unsafe vCard parameters', () => {
    expect(normalizeContactDateLabel('Family;Other')).toBe('Family;Other');
    expect(normalizeContactDateLabel('Family:Other')).toBe('Family:Other');
    expect(normalizeContactDateLabel('Family\r\nX-Evil: injected')).toBeNull();
    expect(normalizeContactDateLabel('Family"Other')).toBeNull();

    const raw = generateVCard({
      uid: 'contact-safe-label-1', displayName: 'Ada',
      contactDates: [
        { label: 'Family:Other', value: '2020-09-14' },
        { label: 'Family;Other', value: '2021-05-06' },
        { label: 'Family\r\nX-Evil: injected', value: '2022-06-07' },
        { label: 'Family"Other', value: '2023-07-08' },
      ],
    });

    expect(raw).toContain('X-ABDATE;TYPE="Family:Other":2020-09-14');
    expect(raw).toContain('X-ABDATE;TYPE="Family;Other":2021-05-06');
    expect(raw).not.toContain('X-Evil');
    expect(raw).not.toContain('2022-06-07');
    expect(raw).not.toContain('2023-07-08');
    expect(parseVCard(raw).contactDates).toEqual([
      { label: 'Family:Other', value: '2020-09-14' },
      { label: 'Family;Other', value: '2021-05-06' },
    ]);
  });

  it('flags a raw line break inside a quoted date label instead of truncating it', () => {
    const parsed = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nX-ABDATE;TYPE="Family\r\nX-Evil: injected":2020-09-14\r\nEND:VCARD\r\n');

    expect(parsed.invalidDateLabels).toEqual(['unterminated parameter']);
    expect(parsed.contactDates).toEqual([]);
  });


  it('round-trips Android/CardDAV birthday and anniversary dates', () => {
    const raw = generateVCard({ uid: 'contact-1', displayName: 'Ada', birthday: '1990-01-02', anniversary: '2020-09-14' });
    expect(raw).toContain('BDAY:1990-01-02');
    expect(raw).toContain('ANNIVERSARY:2020-09-14');
    expect(parseVCard(raw)).toMatchObject({ birthday: '1990-01-02', anniversary: '2020-09-14' });
  });

  it('normalizes compact Android/CardDAV dates', () => {
    const contact = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nBDAY:19900102\r\nANNIVERSARY:20200914\r\nEND:VCARD\r\n');
    expect(contact).toMatchObject({ birthday: '1990-01-02', anniversary: '2020-09-14' });
  });

  it.each([
    ['BDAY:2020-02-30', 'Birthday'],
    ['ANNIVERSARY:2021-02-29', 'Anniversary'],
    ['X-ABDATE;TYPE=Wedding:2023-13-01', 'Wedding'],
    ['X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2024-04-31;0;Meeting;', 'Meeting'],
  ])('omits invalid %s date values', (property, label) => {
    const contact = parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\n${property}\r\nEND:VCARD\r\n`);

    expect(contact.contactDates).not.toContainEqual({ label, value: expect.any(String) });
    expect(contact.invalidDates).toHaveLength(1);
  });
});

describe('vCard local edits', () => {
  it('replaces quoted labelled dates whose label contains a colon', () => {
    const raw = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:contact-quoted-date',
      'FN:Old Name', 'X-ABDATE;TYPE="Family:Other":20200914',
      'END:VCARD',
    ].join('\r\n');
    const merged = mergeVCard(raw, {
      uid: 'contact-quoted-date', displayName: 'Renamed', emails: [], phones: [],
      contactDates: [{ label: 'Family:Other', value: '2024-12-31' }],
    });
    const dateLines = merged.split('\r\n').filter(line => line.startsWith('X-ABDATE'));

    expect(dateLines).toEqual(['X-ABDATE;TYPE="Family:Other":2024-12-31']);
    expect(merged).toContain('FN:Renamed');
  });

  it('preserves unmanaged DAVx5 properties while replacing managed fields', () => {
    const raw = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\nFN:Old Name\r\nN:Name;Old;;;\r\nIMPP;TYPE=work:im:old@example.test\r\nADR;TYPE=home:;;1 Test St;Warsaw;;;PL\r\nX-CUSTOM:preserve me\r\nEND:VCARD\r\n';
    const merged = mergeVCard(raw, { displayName: 'New Name', firstName: 'New', lastName: 'Name', emails: [], phones: [] });

    expect(merged).toContain('FN:New Name');
    expect(merged).toContain('N:Name;New;;;');
    expect(merged).toContain('IMPP;TYPE=work:im:old@example.test');
    expect(merged).toContain('ADR;TYPE=home:;;1 Test St;Warsaw;;;PL');
    expect(merged).toContain('X-CUSTOM:preserve me');
  });
});

describe('vCard rich contact fields', () => {
  it('round-trips standard rich contact properties', () => {
    const source = {
      uid: 'contact-rich-1', displayName: 'Ada Lovelace', emails: [], phones: [],
      title: 'Engineer', role: 'Research', nickname: 'Ada',
      urls: [{ value: 'https://example.test', type: 'work' }],
      instantMessages: [{ value: 'xmpp:ada@example.test', type: 'xmpp' }],
      categories: ['friends', 'engineering'],
      addresses: [{ type: 'home', street: '1 Test St', locality: 'Warsaw', postalCode: '00-001', country: 'PL' }],
    };

    const raw = generateVCard(source);
    expect(raw).toContain('TITLE:Engineer');
    expect(raw).toContain('ROLE:Research');
    expect(raw).toContain('NICKNAME:Ada');
    expect(raw).toContain('URL;TYPE=WORK:https://example.test');
    expect(raw).toContain('IMPP;TYPE=XMPP:xmpp:ada@example.test');
    expect(raw).toContain('CATEGORIES:friends,engineering');
    expect(raw).toContain('ADR;TYPE=HOME:;;1 Test St;Warsaw;;00-001;PL');
    expect(parseVCard(raw)).toMatchObject(source);
  });

  it('preserves escaped CATEGORIES and ADR component separators on round-trip', () => {
    const source = {
      uid: 'contact-escaped-1', displayName: 'Ada', emails: [], phones: [],
      categories: ['friends, family', 'R&D'],
      addresses: [{ type: 'work', pobox: 'Box; 7', extended: 'Floor; 2', street: 'Main; Street', locality: 'Warsaw', region: 'Mazovia', postalCode: '00-001', country: 'PL' }],
    };

    const parsed = parseVCard(generateVCard(source));
    expect(parsed.categories).toEqual(source.categories);
    expect(parsed.addresses).toEqual(source.addresses);
  });

  it('does not expose non-HTTP(S) URLs imported from a vCard', () => {
    const parsed = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nURL:javascript:alert(1)\r\nURL:https://example.test/safe\r\nEND:VCARD\r\n');
    expect(parsed.urls).toEqual([{ value: 'https://example.test/safe', type: 'other' }]);
  });
});
