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

  it('maps every field in Google’s current CSV template and preserves source columns', () => {
    const contacts = parseGoogleCsv([
      'Name Prefix,First Name,Middle Name,Last Name,Name Suffix,Phonetic First Name,Phonetic Middle Name,Phonetic Last Name,Nickname,File As,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Address 1 - Label,Address 1 - Country,Address 1 - Street,Address 1 - Extended Address,Address 1 - City,Address 1 - Region,Address 1 - Postal Code,Address 1 - PO Box,Organization Name,Organization Title,Organization Department,Birthday,Event 1 - Label,Event 1 - Value,Relation 1 - Label,Relation 1 - Value,Website 1 - Label,Website 1 - Value,Custom Field 1 - Label,Custom Field 1 - Value,Notes,Labels',
      'Dr.,Ada,Augusta,Lovelace,III,Ay-da,Aw-gus-ta,Luv-lays,Ada,Analytical Engine,Work,ada@example.test,Mobile,+48123456789,Home,PL,St James Square,Flat 1,London,London,SW1Y 4LB,Box 7,Analytical Society,Mathematician,Research,1815-12-10,Anniversary,1835-01-01,Spouse,William King,Portfolio,https://example.test,Legacy ID,42,First programmer,Friends ::: VIP',
    ].join('\n'));

    expect(contacts).toEqual([expect.objectContaining({
      displayName: 'Dr. Ada Augusta Lovelace III', firstName: 'Ada', lastName: 'Lovelace',
      nickname: 'Ada', organization: 'Analytical Society', title: 'Mathematician', role: 'Research',
      birthday: '1815-12-10',
      contactDates: [{ label: 'Birthday', value: '1815-12-10' }, { label: 'Anniversary', value: '1835-01-01' }],
      emails: [{ value: 'ada@example.test', type: 'work', primary: true }],
      phones: [{ value: '+48123456789', type: 'mobile' }],
      addresses: [{ type: 'home', pobox: 'Box 7', extended: 'Flat 1', street: 'St James Square', locality: 'London', region: 'London', postalCode: 'SW1Y 4LB', country: 'PL' }],
      urls: [{ value: 'https://example.test', type: 'portfolio' }],
      categories: ['Friends', 'VIP'],
      sourceFields: expect.objectContaining({
        'Phonetic First Name': 'Ay-da', 'File As': 'Analytical Engine', 'Organization Department': 'Research',
        'Relation 1 - Label': 'Spouse', 'Relation 1 - Value': 'William King',
        'Custom Field 1 - Label': 'Legacy ID', 'Custom Field 1 - Value': '42',
      }),
    })]);
  });

  it('retains unsafe event labels as source data without serializing them into a vCard', () => {
    const [contact] = parseGoogleCsv('First Name,Event 1 - Label,Event 1 - Value\nAda,"Wedding\r\nX-Evil: injected",2020-09-14');
    expect(contact.contactDates).toEqual([]);
    expect(contact.sourceFields['Event 1 - Label']).toBe('Wedding\r\nX-Evil: injected');
  });
});
