import { describe, expect, it } from 'vitest';
import { contactsToGoogleCsv, contactsToOutlookCsv, contactsToVCard, parseGoogleCsv } from './contactTransfer.js';

const contact = {
  uid: 'c-1', display_name: 'Jan Kowalski', first_name: 'Jan', last_name: 'Kowalski',
  emails: [{ value: 'jan@example.test', type: 'work' }],
  phones: [{ value: '+48123456789', type: 'mobile' }],
  organization: 'Inboxora', title: 'Konsultant', notes: 'Ważny kontakt',
};

describe('contact transfer', () => {
  it('makes spreadsheet formula-like values inert in CSV exports', () => {
    const csv = contactsToGoogleCsv([{ ...contact, display_name: '=HYPERLINK("https://evil.example")' }]);
    expect(csv).toContain("'=HYPERLINK");
  });

  it('exports a Google-compatible CSV with standard headers and escaped values', () => {
    const csv = contactsToGoogleCsv([{ ...contact, notes: 'Pierwsza linia, druga' }]);
    expect(csv).toContain('Name,Given Name,Family Name,Organization 1 - Name,Organization 1 - Title,E-mail 1 - Type,E-mail 1 - Value');
    expect(csv).toContain('Jan Kowalski,Jan,Kowalski,Inboxora,Konsultant,Work,jan@example.test');
    expect(csv).toContain('"Pierwsza linia, druga"');
  });

  it('exports Outlook CSV and vCard from the same contact', () => {
    expect(contactsToOutlookCsv([contact])).toContain('First Name,Middle Name,Last Name,Title,Company');
    expect(contactsToOutlookCsv([contact])).toContain('Jan,,Kowalski,Konsultant,Inboxora');
    expect(contactsToVCard([contact])).toContain('UID:c-1\r\nFN:Jan Kowalski\r\n');
    expect(contactsToVCard([contact])).toContain('EMAIL;TYPE=WORK:jan@example.test');
  });

  it('imports Google CSV rows into Inboxora contact fields', () => {
    const contacts = parseGoogleCsv('Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value\nJan Kowalski,Jan,Kowalski,Work,jan@example.test,Mobile,+48123456789');
    expect(contacts).toEqual([expect.objectContaining({
      displayName: 'Jan Kowalski', firstName: 'Jan', lastName: 'Kowalski',
      emails: [{ value: 'jan@example.test', type: 'work', primary: true }],
      phones: [{ value: '+48123456789', type: 'mobile' }],
    })]);
  });

  it('imports phone-only contacts from the current Google Contacts CSV headers', () => {
    const contacts = parseGoogleCsv([
      'First Name,Middle Name,Last Name,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value',
      'Alicja,,Nowak,Mobile,500 600 700,Work,+48 500 600 701',
      'Bob,,,Komórka,500 600 702,,',
    ].join('\n'));

    expect(contacts).toEqual([
      expect.objectContaining({
        displayName: 'Alicja Nowak', firstName: 'Alicja', lastName: 'Nowak', emails: [],
        phones: [{ value: '500 600 700', type: 'mobile' }, { value: '+48 500 600 701', type: 'work' }],
      }),
      expect.objectContaining({
        displayName: 'Bob', firstName: 'Bob', lastName: null, emails: [],
        phones: [{ value: '500 600 702', type: 'mobile' }],
      }),
    ]);
  });
});
