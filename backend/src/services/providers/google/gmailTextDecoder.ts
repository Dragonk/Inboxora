/**
 * Decode textual Gmail MIME part bytes without corrupting legacy Central-European mail.
 *
 * Gmail's `format=full` body data is base64url-encoded bytes. Most messages either
 * declare their charset correctly or are UTF-8. A small but important class of older
 * mail omits the charset (or claims UTF-8/US-ASCII while carrying Windows-1250 or
 * ISO-8859-2 bytes). Decoding those bytes as UTF-8 replaces Polish diacritics with U+FFFD.
 *
 * Rules:
 *  - honour a supported, explicit non-UTF charset exactly;
 *  - accept valid UTF-8 without heuristics;
 *  - only when UTF-8 is invalid (or an ASCII declaration contains high bytes), compare
 *    Windows-1250 and ISO-8859-2 candidates and choose the less suspicious text;
 *  - never throw on an unknown charset label.
 *
 * The fallback deliberately stays narrow. It is not a general charset detector and it
 * never reinterprets valid UTF-8.
 */

function normalizeCharset(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!raw) return null;
  if (raw === 'utf8') return 'utf-8';
  if (raw === 'latin2' || raw === 'iso8859-2' || raw === 'iso_8859-2') return 'iso-8859-2';
  if (raw === 'cp1250' || raw === 'windows1250' || raw === 'ms-ee') return 'windows-1250';
  if (raw === 'ascii') return 'us-ascii';
  return raw;
}

function decodeWith(bytes: Uint8Array, charset: string, fatal = false): string | null {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

const CENTRAL_EUROPEAN = /[ĄĆĘŁŃÓŚŹŻąćęłńóśźżČĎĚŇŘŠŤŮŽčďěňřšťůžÁÉÍÓÚÝáéíóúýŐŰőűÄÖÜäöü]/gu;
const C1_CONTROLS = /[\u0080-\u009f]/gu;

function plausibility(text: string): number {
  let score = 0;
  score += (text.match(CENTRAL_EUROPEAN) ?? []).length * 8;
  score += (text.match(/\p{L}/gu) ?? []).length * 0.05;
  score -= (text.match(C1_CONTROLS) ?? []).length * 30;
  score -= (text.match(/\uFFFD/gu) ?? []).length * 100;
  score -= text.includes(String.fromCharCode(0)) ? 100 : 0;
  return score;
}

function legacyCentralEuropean(bytes: Uint8Array): string {
  const windows = decodeWith(bytes, 'windows-1250') ?? decodeWith(bytes, 'windows-1252') ?? '';
  const latin2 = decodeWith(bytes, 'iso-8859-2') ?? windows;
  return plausibility(latin2) > plausibility(windows) ? latin2 : windows;
}

export function decodeGmailText(bytes: Uint8Array, declaredCharset?: string | null): string {
  const charset = normalizeCharset(declaredCharset);

  // Explicit legacy charsets are authoritative. This also handles correctly declared
  // Polish/Czech mail without ever touching the heuristic path.
  if (charset && charset !== 'utf-8' && charset !== 'us-ascii') {
    const decoded = decodeWith(bytes, charset);
    if (decoded !== null) return decoded;
  }

  // Valid UTF-8 always wins, including when no charset was declared.
  const utf8 = decodeWith(bytes, 'utf-8', true);
  if (utf8 !== null) return utf8;

  // An ASCII declaration is only trustworthy for 7-bit content. High bytes mean the
  // sender mislabeled the part, so use the same bounded fallback as an absent charset.
  if (charset === 'us-ascii' && Array.from(bytes).every(byte => byte < 0x80)) {
    return new TextDecoder('us-ascii').decode(bytes);
  }

  return legacyCentralEuropean(bytes);
}
