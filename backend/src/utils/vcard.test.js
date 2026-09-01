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
