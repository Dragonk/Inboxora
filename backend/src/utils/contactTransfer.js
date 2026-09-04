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
  return ({ cell: 'mobile', iphone: 'mobile', work: 'work', home: 'home', mobile: 'mobile' })[type] || fallback;
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
  const get = (row, name) => row[columns.get(name)]?.trim() || '';
  return rows.map(row => {
    const email = get(row, 'E-mail 1 - Value');
    const phone = get(row, 'Phone 1 - Value');
    const displayName = get(row, 'Name') || [get(row, 'Given Name'), get(row, 'Family Name')].filter(Boolean).join(' ');
    if (!displayName && !email) return null;
    return {
      displayName, firstName: get(row, 'Given Name') || null, lastName: get(row, 'Family Name') || null,
      emails: email ? [{ value: email.toLowerCase(), type: normalizeType(get(row, 'E-mail 1 - Type')), primary: true }] : [],
      phones: phone ? [{ value: phone, type: normalizeType(get(row, 'Phone 1 - Type')) }] : [],
      organization: get(row, 'Organization 1 - Name') || null, title: get(row, 'Organization 1 - Title') || null, notes: get(row, 'Notes') || null,
    };
  }).filter(Boolean);
}
