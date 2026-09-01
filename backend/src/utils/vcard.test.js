import { describe, expect, it } from 'vitest';
import { generateVCard, mergeVCard, parseVCard } from './vcard.js';

describe('vCard contact dates', () => {
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
});

describe('vCard local edits', () => {
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
