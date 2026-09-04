import { normalizeContactDateLabel } from './vcard.js';

function csvEscape(value) {
  let text = String(value ?? '');
  // Spreadsheets execute cells beginning with these characters as formulas.
  // Exported contact data is untrusted, so force a text cell instead.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(columns) {
  return columns.map(csvEscape).join(',');
}

function firstValue(entries = []) {
  return entries.find(entry => entry?.value?.trim())?.value?.trim() || '';
}

function contactName(contact) {
  return contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || firstValue(contact.emails);
}

function normalizeType(value, fallback = 'other') {
  const type = String(value || fallback).trim().toLowerCase();
  return ({ cell: 'mobile', iphone: 'mobile', work: 'work', home: 'home', mobile: 'mobile', 'komórka': 'mobile', 'komorkowy': 'mobile', 'służbowy': 'work', 'sluzbowy': 'work', dom: 'home' })[type] || type || fallback;
}

function csvType(value) {
  const type = normalizeType(value);
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function vcardEscape(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

export function contactsToGoogleCsv(contacts) {
  const header = ['Name', 'Given Name', 'Family Name', 'Organization 1 - Name', 'Organization 1 - Title', 'E-mail 1 - Type', 'E-mail 1 - Value', 'Phone 1 - Type', 'Phone 1 - Value', 'Notes'];
  return [header, ...contacts.map(contact => {
    const email = contact.emails?.[0] || {};
    const phone = contact.phones?.[0] || {};
    return [contactName(contact), contact.first_name || '', contact.last_name || '', contact.organization || '', contact.title || '', csvType(email.type), email.value || '', csvType(phone.type), phone.value || '', contact.notes || ''];
  })].map(csvRow).join('\r\n');
}

export function contactsToOutlookCsv(contacts) {
  const header = ['First Name', 'Middle Name', 'Last Name', 'Title', 'Company', 'E-mail Address', 'Business Phone', 'Mobile Phone', 'Notes'];
  return [header, ...contacts.map(contact => {
    const emails = contact.emails || [];
    const phones = contact.phones || [];
    const business = phones.find(phone => normalizeType(phone.type) === 'work');
    const mobile = phones.find(phone => normalizeType(phone.type) === 'mobile');
    return [contact.first_name || '', '', contact.last_name || '', contact.title || '', contact.organization || '', firstValue(emails), business?.value || '', mobile?.value || '', contact.notes || ''];
  })].map(csvRow).join('\r\n');
}

export function contactsToVCard(contacts) {
  return contacts.map(contact => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${vcardEscape(contact.uid)}`, `FN:${vcardEscape(contactName(contact))}`, `N:${vcardEscape(contact.last_name)};${vcardEscape(contact.first_name)};;;`];
    for (const email of contact.emails || []) if (email?.value) lines.push(`EMAIL;TYPE=${normalizeType(email.type).toUpperCase()}:${vcardEscape(email.value)}`);
    for (const phone of contact.phones || []) if (phone?.value) lines.push(`TEL;TYPE=${normalizeType(phone.type).toUpperCase()}:${vcardEscape(phone.value)}`);
    if (contact.organization) lines.push(`ORG:${vcardEscape(contact.organization)}`);
    if (contact.title) lines.push(`TITLE:${vcardEscape(contact.title)}`);
    if (contact.notes) lines.push(`NOTE:${vcardEscape(contact.notes)}`);
    lines.push('END:VCARD', '');
    return lines.join('\r\n');
  }).join('');
}

function parseCsv(text) {
  const rows = [];
  let row = []; let value = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { value += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function parseGoogleCsv(text) {
  const [header = [], ...rows] = parseCsv(String(text || ''));
  const columns = new Map(header.map((name, index) => [name.trim(), index]));
  const get = (row, ...names) => names.map(name => row[columns.get(name)]?.trim() || '').find(Boolean) || '';
  const indexedFields = field => [...columns.keys()]
    .map(name => new RegExp(`^${field} (\\d+) - `).exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((number, index, values) => values.indexOf(number) === index)
    .sort((a, b) => a - b);
  const entries = (row, field) => {
    const values = [];
    for (const number of indexedFields(field)) {
      const value = get(row, `${field} ${number} - Value`);
      if (value) values.push({ value, type: normalizeType(get(row, `${field} ${number} - Type`, `${field} ${number} - Label`)) });
    }
    return values;
  };
  const validDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
  };
  const labels = value => value.split(/\s+:::\s+/).map(label => label.trim()).filter(Boolean);
  return rows.map(row => {
    const emails = entries(row, 'E-mail').map((email, index) => ({ ...email, value: email.value.toLowerCase(), primary: index === 0 }));
    const phones = entries(row, 'Phone');
    const firstName = get(row, 'Given Name', 'First Name');
    const lastName = get(row, 'Family Name', 'Last Name');
    const middleName = get(row, 'Additional Name', 'Middle Name');
    const displayName = get(row, 'Name') || [get(row, 'Name Prefix'), firstName, middleName, lastName, get(row, 'Name Suffix')].filter(Boolean).join(' ');
    const addresses = indexedFields('Address').map(number => ({
      type: normalizeType(get(row, `Address ${number} - Type`, `Address ${number} - Label`)),
      pobox: get(row, `Address ${number} - PO Box`),
      extended: get(row, `Address ${number} - Extended Address`),
      street: get(row, `Address ${number} - Street`, `Address ${number} - Formatted`),
      locality: get(row, `Address ${number} - City`),
      region: get(row, `Address ${number} - Region`),
      postalCode: get(row, `Address ${number} - Postal Code`),
      country: get(row, `Address ${number} - Country`),
    })).filter(address => Object.entries(address).some(([key, value]) => key !== 'type' && value));
    const urls = indexedFields('Website').map(number => ({
      value: get(row, `Website ${number} - Value`),
      type: normalizeType(get(row, `Website ${number} - Type`, `Website ${number} - Label`)),
    })).filter(({ value }) => /^https?:\/\//i.test(value));
    const birthday = validDate(get(row, 'Birthday'));
    const contactDates = indexedFields('Event').flatMap(number => {
      const value = validDate(get(row, `Event ${number} - Value`));
      const label = normalizeContactDateLabel(get(row, `Event ${number} - Label`) || 'Other');
      return value && label ? [{ label, value }] : [];
    });
    if (birthday && !contactDates.some(date => date.label.toLowerCase() === 'birthday' && date.value === birthday)) contactDates.unshift({ label: 'Birthday', value: birthday });
    const sourceFields = Object.fromEntries(header.map((name, index) => [name.trim(), row[index]?.trim() || '']).filter(([, value]) => value));
    if (!displayName && !emails.length && !phones.length && !addresses.length && !Object.keys(sourceFields).length) return null;
    return {
      displayName, firstName: firstName || null, lastName: lastName || null,
      emails, phones,
      organization: get(row, 'Organization 1 - Name', 'Organization Name') || null,
      title: get(row, 'Organization 1 - Title', 'Organization Title') || null,
      role: get(row, 'Organization Department') || null,
      nickname: get(row, 'Nickname') || null,
      birthday,
      anniversary: contactDates.find(date => date.label.toLowerCase() === 'anniversary')?.value || null,
      contactDates,
      urls,
      addresses,
      categories: labels(get(row, 'Labels', 'Group Membership')),
      notes: get(row, 'Notes') || null,
      sourceFields,
    };
  }).filter(Boolean);
}
