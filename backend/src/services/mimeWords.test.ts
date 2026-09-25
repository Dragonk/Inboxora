import { describe, expect, it } from 'vitest';
import { decodeMimeWords, parseMailboxList } from './messageParser.js';

/**
 * RFC 2047 encoded words are decoded with **their own charset**.
 *
 * A live acceptance round reported Polish characters "sometimes not working": a sender's name came through as
 * `Kamil Maci?g` instead of `Kamil Maciąg`. The cause was here: every encoded word was decoded as UTF-8. When
 * the sender's client used a legacy single-byte charset — ISO-8859-2 and Windows-1250 are both common for
 * Polish, and Outlook emits Windows-1250 — the octets are not valid UTF-8, so the decoder produced replacement
 * characters. Mail from a client that used UTF-8 was fine, which is exactly why the fault looked intermittent.
 */

describe('decoding RFC 2047 encoded words', () => {
  it('decodes a Polish name from ISO-8859-2, which is not valid UTF-8', () => {
    // "Kamil Maci±g" in ISO-8859-2: 0xB1 is ą. As UTF-8 that byte is an invalid continuation.
    expect(decodeMimeWords('=?iso-8859-2?Q?Kamil_Maci=B1g?=')).toBe('Kamil Maciąg');
    // The same text in base64, as clients that prefer B encoding emit it (0xB1 is ą in ISO-8859-2).
    const isoBytes = [0x4B, 0x61, 0x6D, 0x69, 0x6C, 0x20, 0x4D, 0x61, 0x63, 0x69, 0xB1, 0x67];
    expect(decodeMimeWords(`=?iso-8859-2?B?${Buffer.from(isoBytes).toString('base64')}?=`)).toBe('Kamil Maciąg');
  });

  it('decodes a Polish name from Windows-1250, which Outlook uses', () => {
    // 0xB9 is ą in Windows-1250 — a different octet than ISO-8859-2, which is why the label must be honoured
    // rather than guessed.
    expect(decodeMimeWords('=?windows-1250?Q?Kamil_Maci=B9g?=')).toBe('Kamil Maciąg');
    expect(decodeMimeWords('=?Windows-1250?B?S2FtaWwgTWFjabln?=')).toBe('Kamil Maciąg');
  });

  it('decodes a Polish subject from Windows-1250', () => {
    // "Zażółć gęślą jaźń" as the octets a Windows-1250 client emits (ą is 0xB9 there, not ISO-8859-2's 0xB1).
    const winBytes = [0x5A, 0x61, 0xBF, 0xF3, 0xB3, 0xE6, 0x20, 0x67, 0xEA, 0x9C, 0x6C, 0xB9, 0x20, 0x6A, 0x61, 0x9F, 0xF1];
    expect(decodeMimeWords(`=?windows-1250?B?${Buffer.from(winBytes).toString('base64')}?=`)).toBe('Zażółć gęślą jaźń');
  });

  it('leaves UTF-8 encoded words exactly as they were', () => {
    expect(decodeMimeWords(`=?utf-8?B?${Buffer.from('Kamil Maciąg', 'utf8').toString('base64')}?=`)).toBe('Kamil Maciąg');
    expect(decodeMimeWords('=?utf-8?Q?Kamil_Maci=C4=85g?=')).toBe('Kamil Maciąg');
    // The label may carry a language tag, which is not part of the charset.
    expect(decodeMimeWords('=?utf-8*en?Q?Kamil_Maci=C4=85g?=')).toBe('Kamil Maciąg');
  });

  it('treats underscore as a space and keeps literal text intact', () => {
    expect(decodeMimeWords('=?utf-8?Q?Za=C5=BC=C3=B3=C5=82=C4=87_g=C4=99=C5=9Bl=C4=85_ja=C5=BA=C5=84?='))
      .toBe('Zażółć gęślą jaźń');
  });

  it('joins adjacent encoded words separated by whitespace, per RFC 2047 §6.2', () => {
    // A long name is split by the sender into two encoded words; the whitespace between them is not part of
    // the value.
    const first = `=?utf-8?B?${Buffer.from('Kamil ', 'utf8').toString('base64')}?=`;
    const second = `=?utf-8?B?${Buffer.from('Maciąg', 'utf8').toString('base64')}?=`;
    expect(decodeMimeWords(`${first} ${second}`)).toBe('Kamil Maciąg');
  });

  it('does not fail on a charset the runtime does not know', () => {
    // An unknown single-byte charset falls back byte-for-byte, which keeps the ASCII part readable; the
    // important part is that a header never throws or disappears because of its label.
    const decoded = decodeMimeWords('=?x-nonesuch-charset?Q?Kamil_Maci=B1g?=');
    expect(decoded).toContain('Kamil Maci');
  });

  it('returns a plain header untouched', () => {
    expect(decodeMimeWords('Kamil Maciąg <kamil@example.test>')).toBe('Kamil Maciąg <kamil@example.test>');
    expect(decodeMimeWords('')).toBe('');
  });

  it('decodes an ascii encoded word without inventing characters', () => {
    expect(decodeMimeWords('=?us-ascii?Q?plain_text?=')).toBe('plain text');
  });
});

describe('the address path that shows a sender name', () => {
  it('decodes a Windows-1250 sender name in a From header', () => {
    // The reported symptom: the name was shown as `Kamil Maci?g`. The header is what the mail client wrote,
    // and the address parser decodes it before it is stored or displayed.
    const parsed = parseMailboxList('=?windows-1250?Q?Kamil_Maci=B9g?= <kamil@example.test>');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ email: 'kamil@example.test', name: 'Kamil Maciąg' });
  });

  it('decodes an ISO-8859-2 sender name alongside an ASCII address', () => {
    const parsed = parseMailboxList('"=?iso-8859-2?Q?Kamil_Maci=B1g?=" <kamil@example.test>');
    expect(parsed[0]).toMatchObject({ email: 'kamil@example.test', name: 'Kamil Maciąg' });
  });

  it('keeps a UTF-8 name unchanged', () => {
    const parsed = parseMailboxList('=?utf-8?Q?Kamil_Maci=C4=85g?= <kamil@example.test>');
    expect(parsed[0]).toMatchObject({ email: 'kamil@example.test', name: 'Kamil Maciąg' });
  });
});
