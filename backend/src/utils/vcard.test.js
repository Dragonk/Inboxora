import { describe, expect, it } from 'vitest';
import { generateVCard, parseVCard } from './vcard.js';

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
