// vCard 3.0 parser and generator (RFC 2426).
// Used by the contacts REST API and the CardDAV server.

// Sanitize a vCard parameter value (e.g. TYPE=...).
// Strips CR, LF, and other characters that are structural in vCard lines.
function escapeParam(str) {
  if (!str) return '';
  return str.replace(/[\r\n;]/g, '');
}

// Escape special characters in a vCard property value.
function escapeValue(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// Unescape a vCard property value.
function unescapeValue(str) {
  if (!str) return '';
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Split structured or list values without treating escaped delimiters as
// separators. Keep escapes in the fragments so unescapeValue() can decode them.
function splitEscaped(value, delimiter) {
  const parts = [];
  let part = '';
  let escaped = false;
  for (const char of value) {
    if (char === delimiter && !escaped) {
      parts.push(part);
      part = '';
    } else {
      part += char;
    }
    escaped = char === '\\' ? !escaped : false;
  }
  parts.push(part);
  return parts;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeDate(value) {
  const date = unescapeValue(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

// Fold a vCard line at 75 octets per RFC 6350 §3.2.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line + '\r\n';
  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const max = first ? 75 : 74; // continuation lines have a leading space
    // Walk back to a character boundary
    let end = offset + max;
    if (end >= bytes.length) {
      end = bytes.length;
    } else {
      // back off until we're at a UTF-8 character boundary
      while (end > offset && (bytes[end] & 0xC0) === 0x80) end--;
    }
    const chunk = bytes.slice(offset, end).toString('utf8');
    parts.push((first ? '' : ' ') + chunk);
    offset = end;
    first = false;
  }
  return parts.join('\r\n') + '\r\n';
}

// Unfold a raw vCard string — join lines that start with whitespace.
function unfold(raw) {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

/**
 * Parse a vCard 3.0 string and return a plain object with the fields
 * MailFlow cares about. Unknown properties are silently ignored.
 *
 * Returns: { uid, displayName, firstName, lastName, emails, phones, organization, notes, photoData }
 */
export function parseVCard(raw) {
  const text = unfold(raw || '');
  const result = {
    uid: null,
    displayName: null,
    firstName: null,
    lastName: null,
    emails: [],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    birthday: null,
    anniversary: null,
    title: null,
    role: null,
    nickname: null,
    urls: [],
    instantMessages: [],
    categories: [],
    addresses: [],
    contactDates: [],
    invalidDates: [],
  };

  const addContactDate = (label, value) => {
    const normalized = normalizeDate(value);
    const cleanLabel = unescapeValue(label || '').trim().replace(/^"|"$/g, '') || 'Other';
    if (!normalized) return;
    const key = `${cleanLabel.toLocaleLowerCase()}\u0000${normalized}`;
    if (!result.contactDates.some(date => `${date.label.toLocaleLowerCase()}\u0000${date.value}` === key)) {
      result.contactDates.push({ label: cleanLabel, value: normalized });
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'BEGIN:VCARD' || trimmed === 'END:VCARD') continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;

    const rawName = trimmed.slice(0, colonIdx);
    const value   = trimmed.slice(colonIdx + 1);

    // Strip parameters (e.g. "EMAIL;TYPE=WORK:..." → name = "EMAIL"), then drop an
    // optional group prefix (e.g. "ITEM1.EMAIL" → "EMAIL") used by Apple/Nextcloud.
    let name = rawName.split(';')[0].toUpperCase();
    if (name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);
    const params = rawName.includes(';') ? rawName.slice(rawName.indexOf(';') + 1) : '';

    switch (name) {
      case 'VERSION': break; // ignore
      case 'UID':
        result.uid = unescapeValue(value).trim();
        break;
      case 'FN':
        result.displayName = unescapeValue(value).trim() || null;
        break;
      case 'N': {
        // N:Last;First;Additional;Prefix;Suffix
        const parts = value.split(';').map(p => unescapeValue(p).trim());
        result.lastName  = parts[0] || null;
        result.firstName = parts[1] || null;
        break;
      }
      case 'EMAIL': {
        const emailVal = unescapeValue(value).trim().toLowerCase();
        if (emailVal) {
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const type = typeMatch ? typeMatch[1].toLowerCase().replace(/["']/g, '') : 'other';
          const isPrimary = result.emails.length === 0;
          result.emails.push({ value: emailVal, type, primary: isPrimary });
        }
        break;
      }
      case 'TEL': {
        const phoneVal = unescapeValue(value).trim();
        if (phoneVal) {
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const type = typeMatch ? typeMatch[1].toLowerCase().replace(/["']/g, '') : 'other';
          result.phones.push({ value: phoneVal, type });
        }
        break;
      }
      case 'ORG':
        result.organization = unescapeValue(value.split(';')[0]).trim() || null;
        break;
      case 'NOTE':
        result.notes = unescapeValue(value).trim() || null;
        break;
      case 'BDAY': {
        result.birthday = result.birthday || normalizeDate(value);
        addContactDate(params.match(/(?:TYPE|LABEL)=("[^"]+"|[^;]+)/i)?.[1] || 'Birthday', value);
        break;
      }
      case 'ANNIVERSARY': {
        result.anniversary = result.anniversary || normalizeDate(value);
        addContactDate(params.match(/(?:TYPE|LABEL)=("[^"]+"|[^;]+)/i)?.[1] || 'Anniversary', value);
        break;
      }
      case 'X-ABDATE':
        addContactDate(params.match(/(?:TYPE|LABEL)=("[^"]+"|[^;]+)/i)?.[1] || 'Other', value);
        break;
      case 'X-ANDROID-CUSTOM': {
        const parts = splitEscaped(value, ';').map(part => unescapeValue(part));
        if (parts[0] === 'vnd.android.cursor.item/contact_event') addContactDate(parts[2], parts[3]);
        break;
      }
      case 'TITLE':
        result.title = unescapeValue(value).trim() || null;
        break;
      case 'ROLE':
        result.role = unescapeValue(value).trim() || null;
        break;
      case 'NICKNAME':
        result.nickname = unescapeValue(value).trim() || null;
        break;
      case 'URL': {
        const url = unescapeValue(value).trim();
        if (isHttpUrl(url)) result.urls.push({ value: url, type: (params.match(/TYPE=([^;]+)/i)?.[1] || 'other').toLowerCase().replace(/["']/g, '') });
        break;
      }
      case 'IMPP': {
        const im = unescapeValue(value).trim();
        if (im) result.instantMessages.push({ value: im, type: (params.match(/TYPE=([^;]+)/i)?.[1] || im.split(':', 1)[0] || 'other').toLowerCase().replace(/["']/g, '') });
        break;
      }
      case 'CATEGORIES':
        result.categories.push(...splitEscaped(value, ',').map(part => unescapeValue(part).trim()).filter(Boolean));
        break;
      case 'ADR': {
        const parts = splitEscaped(value, ';').map(part => unescapeValue(part).trim());
        result.addresses.push({ type: (params.match(/TYPE=([^;]+)/i)?.[1] || 'other').toLowerCase().replace(/["']/g, ''), pobox: parts[0] || '', extended: parts[1] || '', street: parts[2] || '', locality: parts[3] || '', region: parts[4] || '', postalCode: parts[5] || '', country: parts[6] || '' });
        break;
      }
      case 'PHOTO': {
        const v = value.trim();
        if (!v) break;
        if (v.startsWith('data:')) {
          // vCard 4.0 inline data URI — store as-is.
          result.photoData = v;
        } else if (/^https?:\/\//i.test(v)) {
          // External URL — skip to avoid privacy leak / fetch complexity.
          result.photoData = null;
        } else {
          // vCard 3.0 ENCODING=b raw base64 — derive MIME from TYPE param.
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const rawType = typeMatch ? typeMatch[1].replace(/["']/g, '').toUpperCase() : 'JPEG';
          const mimeMap = { JPEG: 'image/jpeg', JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp' };
          const mimeType = mimeMap[rawType] || 'image/jpeg';
          result.photoData = `data:${mimeType};base64,${v}`;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Generate a vCard 3.0 string from a contact object.
 *
 * contact: { uid, displayName, firstName, lastName, emails, phones, organization, notes }
 */
export function generateVCard(contact) {
  const {
    uid,
    displayName,
    firstName,
    lastName,
    emails = [],
    phones = [],
    organization,
    notes,
    birthday,
    anniversary,
    title,
    role,
    nickname,
    urls = [],
    instantMessages = [],
    categories = [],
    addresses = [],
    contactDates,
  } = contact;

  const lines = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');
  lines.push(`UID:${escapeValue(uid || '')}`);

  const fn = displayName
    || (firstName || lastName ? [firstName, lastName].filter(Boolean).join(' ') : null)
    || (emails[0]?.value ?? '');
  lines.push(`FN:${escapeValue(fn)}`);

  if (firstName || lastName) {
    lines.push(`N:${escapeValue(lastName || '')};${escapeValue(firstName || '')};;;`);
  }

  for (const e of emails) {
    const type = escapeParam((e.type || 'other').toUpperCase());
    lines.push(`EMAIL;TYPE=${type}:${escapeValue(e.value || '')}`);
  }

  for (const p of phones) {
    const type = escapeParam((p.type || 'voice').toUpperCase());
    lines.push(`TEL;TYPE=${type}:${escapeValue(p.value || '')}`);
  }

  if (organization) {
    lines.push(`ORG:${escapeValue(organization)}`);
  }

  if (notes) {
    lines.push(`NOTE:${escapeValue(notes)}`);
  }
  if (Array.isArray(contactDates)) {
    const seenDates = new Set();
    for (const date of contactDates) {
      const value = normalizeDate(date?.value);
      const label = typeof date?.label === 'string' && date.label.trim() ? date.label.trim() : 'Other';
      const key = `${label.toLocaleLowerCase()}\u0000${value}`;
      if (!value || seenDates.has(key)) continue;
      seenDates.add(key);
      const property = label.toLocaleLowerCase() === 'birthday' ? 'BDAY' : label.toLocaleLowerCase() === 'anniversary' ? 'ANNIVERSARY' : 'X-ABDATE';
      const encodedLabel = /[,:"]/.test(label) ? `"${escapeParam(label).replace(/"/g, '\\"')}"` : escapeParam(label);
      lines.push(`${property};TYPE=${encodedLabel}:${value}`);
    }
  } else {
    if (/^\d{4}-\d{2}-\d{2}$/.test(birthday || '')) lines.push(`BDAY:${birthday}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(anniversary || '')) lines.push(`ANNIVERSARY:${anniversary}`);
  }
  if (title) lines.push(`TITLE:${escapeValue(title)}`);
  if (role) lines.push(`ROLE:${escapeValue(role)}`);
  if (nickname) lines.push(`NICKNAME:${escapeValue(nickname)}`);
  for (const url of urls) if (url?.value) lines.push(`URL;TYPE=${escapeParam((url.type || 'other').toUpperCase())}:${escapeValue(url.value)}`);
  for (const instantMessage of instantMessages) if (instantMessage?.value) lines.push(`IMPP;TYPE=${escapeParam((instantMessage.type || 'other').toUpperCase())}:${escapeValue(instantMessage.value)}`);
  if (categories.length) lines.push(`CATEGORIES:${categories.map(escapeValue).join(',')}`);
  for (const address of addresses) {
    const type = escapeParam((address?.type || 'other').toUpperCase());
    const parts = ['pobox', 'extended', 'street', 'locality', 'region', 'postalCode', 'country'].map(key => escapeValue(address?.[key] || ''));
    lines.push(`ADR;TYPE=${type}:${parts.join(';')}`);
  }

  lines.push('END:VCARD');

  // Fold and join
  return lines.map(foldLine).join('');
}

// Update only the properties owned by the local contact editor. The original
// vCard remains the source of truth for DAV clients, so unsupported extensions
// (including grouped Apple properties and X-* fields) survive local edits.
export function mergeVCard(raw, contact) {
  const original = unfold(raw || '');
  if (!/^BEGIN:VCARD\s*$/im.test(original) || !/^END:VCARD\s*$/im.test(original)) {
    return generateVCard(contact);
  }
  const managed = new Set(['FN', 'N', 'EMAIL', 'TEL', 'ORG', 'NOTE', 'BDAY', 'ANNIVERSARY', 'X-ABDATE', 'X-ANDROID-CUSTOM']);
  const richProperties = { title: 'TITLE', role: 'ROLE', nickname: 'NICKNAME', urls: 'URL', instantMessages: 'IMPP', categories: 'CATEGORIES', addresses: 'ADR' };
  for (const [field, property] of Object.entries(richProperties)) {
    if (Object.hasOwn(contact, field)) managed.add(property);
  }
  const propertyName = line => {
    const colon = line.indexOf(':');
    if (colon < 0) return '';
    const name = line.slice(0, colon).split(';', 1)[0].toUpperCase();
    return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  };
  const existing = original.split(/\r?\n/).filter(Boolean);
  const uid = contact.uid || parseVCard(original).uid;
  const replacement = unfold(generateVCard({ ...contact, uid })).split(/\r?\n/)
    .filter(line => line && !['BEGIN', 'VERSION', 'UID', 'END'].includes(propertyName(line)));
  const preserved = existing.filter(line => {
    const name = propertyName(line);
    return name && !['BEGIN', 'END'].includes(name) && !managed.has(name);
  });
  return ['BEGIN:VCARD', ...preserved, ...replacement, 'END:VCARD'].map(foldLine).join('');
}
