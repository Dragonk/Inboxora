import { describe, expect, it } from 'vitest';
import { renderGraphMessage } from './graphMailSend.js';
import { graphEventPayloadFor } from './graphCalendarWrites.js';
import { graphContactPayloadFor } from './graphContactWrites.js';
import { boundGraphSearchQuery, escapeGraphSearchQuery, graphMailSearchUrl } from './graphMailSearch.js';
import type { ComposedMail } from '../../composedMail.js';

/**
 * Non-ASCII text through the Microsoft Graph payloads.
 *
 * A live acceptance round reported Polish characters "sometimes not working" with Graph. Every Graph request
 * this adapter sends is JSON with the text as a plain field — never an RFC 2047 encoded-word, which is a MIME
 * header representation and would be shown literally by Outlook if it were used here — so what has to hold is
 * that the text reaches the payload unchanged and survives JSON serialisation, which is UTF-8.
 *
 * These cases pin that. They are deliberately about the *values* the adapter builds, because the transport
 * below them (`JSON.stringify` into a `content-type: application/json` request, and `response.json()` back) is
 * UTF-8 in Node, and a failing case here would mean the text was mangled before it ever left.
 */

// Every Polish letter that is not ASCII, plus the ones that are (so a wrong encoding is visible either way).
const POLISH = 'Zażółć gęślą jaźń ŁÓDŹ ćma ślimak źdźbło';
const POLISH_SUBJECT = 'Zamówienie: zażółć gęślą jaźń';

const composed = (overrides: Partial<ComposedMail> = {}): ComposedMail => ({
  from: { name: POLISH, email: 'sender@example.test' },
  to: [{ name: POLISH, email: 'to@example.test' }],
  cc: [],
  bcc: [],
  subject: POLISH_SUBJECT,
  plainBody: POLISH,
  htmlBody: `<p>${POLISH}</p>`,
  messageId: '<m@example.test>',
  ...overrides,
} as ComposedMail);

/** True when the JSON round-trip preserved the text byte-for-byte in UTF-8. */
const survivesJson = (value: unknown): boolean => {
  const serialized = JSON.stringify(value);
  // The bytes on the wire are UTF-8; a Latin-1 encoding would replace every Polish letter with two bytes that
  // decode back as mojibake.
  const bytes = Buffer.from(serialized, 'utf8');
  return JSON.parse(bytes.toString('utf8')) !== undefined && bytes.toString('utf8') === serialized;
};

describe('Polish text in Graph payloads', () => {
  it('sends a mail subject and body as plain JSON text, not as an encoded word', () => {
    const message = renderGraphMessage(composed());

    expect(message.subject).toBe(POLISH_SUBJECT);
    // An encoded word here would be shown literally by Outlook: `$search`/JSON fields are not MIME headers.
    expect(message.subject).not.toContain('=?');
    expect(message.body.content).toContain(POLISH);
    expect(survivesJson(message)).toBe(true);
  });

  it('keeps a Polish display name in the recipient and sender', () => {
    const message = renderGraphMessage(composed()) as unknown as {
      toRecipients?: Array<{ emailAddress?: { name?: string } }>;
    };
    expect(message.toRecipients?.[0]?.emailAddress?.name).toBe(POLISH);
    expect(survivesJson(message)).toBe(true);
  });

  it('keeps Polish text in a calendar event', () => {
    const payload = graphEventPayloadFor({
      summary: POLISH_SUBJECT,
      description: POLISH,
      location: `Łódź, ul. Źródlana 1`,
      startsAt: new Date('2026-03-01T09:00:00.000Z'),
      endsAt: new Date('2026-03-01T10:00:00.000Z'),
      allDay: false,
      attendees: [],
    } as never);

    expect(payload.subject).toBe(POLISH_SUBJECT);
    expect(payload.body?.content).toContain(POLISH);
    expect(payload.location?.displayName).toContain('Łódź');
    expect(survivesJson(payload)).toBe(true);
  });

  it('keeps Polish text in a contact', () => {
    const payload = graphContactPayloadFor({
      uid: 'uid-1',
      displayName: POLISH,
      firstName: 'Żaneta',
      lastName: 'Ćwikła',
      emails: [{ value: 'z.cwikla@example.test', primary: true, type: 'work' }],
      phones: [],
    } as never, 'create');

    expect(payload.displayName).toBe(POLISH);
    expect(payload.givenName).toBe('Żaneta');
    expect(payload.surname).toBe('Ćwikła');
    expect(survivesJson(payload)).toBe(true);
  });

  it('does not truncate a Polish string in the middle of a character', () => {
    // Character-based bounds are safe; a byte-based slice would split a two-byte letter and produce a
    // replacement character at the end of the truncated value.
    const long = POLISH.repeat(50);
    const payload = graphEventPayloadFor({
      summary: long.slice(0, 120),
      description: null,
      location: null,
      startsAt: new Date('2026-03-01T09:00:00.000Z'),
      endsAt: new Date('2026-03-01T10:00:00.000Z'),
      allDay: false,
      attendees: [],
    } as never);
    expect(payload.subject).not.toContain('\uFFFD');
    expect(payload.subject).toBe(long.slice(0, 120));
  });
});

describe('Polish text in a Graph search', () => {
  it('percent-encodes the query as UTF-8 and keeps the KQL literal intact', () => {
    const query = `zażółć "gęślą" jaźń`;
    const url = graphMailSearchUrl(query, { top: 5 });

    // The URL is UTF-8 percent-encoded, so a client or proxy cannot corrupt it, and decoding it returns the
    // query exactly as the user typed it (with the KQL quote escaped inside the literal).
    const parsed = new URL(url);
    expect(parsed.searchParams.get('$search')).toBe(`"${escapeGraphSearchQuery(query)}"`);
    expect(parsed.searchParams.get('$search')).toContain('zażółć');
    expect(decodeURIComponent(url)).toContain('zażółć');
  });

  it('escapes the KQL quote and backslash without touching Polish letters', () => {
    const escaped = escapeGraphSearchQuery('a\\b "ćma"');
    expect(escaped).toBe('a\\\\b \\"ćma\\"');
    expect(escaped).toContain('ćma');
  });

  it('bounds the query by characters, never mid-character', () => {
    const long = 'ż'.repeat(600);
    const bounded = boundGraphSearchQuery(long);
    expect(bounded).toHaveLength(500);
    expect(bounded).not.toContain('\uFFFD');
  });
});
