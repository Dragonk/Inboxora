import { describe, expect, it } from 'vitest';
import { descriptionContentLines, htmlToPlainText, isHtmlDescription, normalizeDescription, sanitizeDescriptionHtml } from './richText.js';
import { parseCalendarEvent } from './ical.js';

const escape = (value) => String(value || '')
  .replaceAll('\\', '\\\\')
  .replaceAll('\r\n', '\n')
  .replaceAll('\n', '\\n')
  .replaceAll(';', '\\;')
  .replaceAll(',', '\\,');

const wrap = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:event-1',
  'DTSTART:20260911T100000Z', 'DTEND:20260911T110000Z', 'SUMMARY:Planning', ...lines,
  'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

describe('description text and HTML detection', () => {
  it('treats only real markup as HTML', () => {
    expect(isHtmlDescription('meeting at 5 < 6, a > b')).toBe(false);
    expect(isHtmlDescription('plain\ntext')).toBe(false);
    expect(isHtmlDescription('<p>hello</p>')).toBe(true);
    expect(isHtmlDescription('line one<br>line two')).toBe(true);
  });

  it('flattens markup into readable lines without leaking script bodies', () => {
    expect(htmlToPlainText('<p>Plan &amp; details</p><script>hidden()</script><ul><li>One</li><li>Two</li></ul>'))
      .toBe('Plan & details\nOne\nTwo');
  });

  it('normalizes empty and HTML descriptions', () => {
    expect(normalizeDescription('   ')).toBeNull();
    expect(normalizeDescription(undefined)).toBeNull();
    expect(normalizeDescription(' Agenda ')).toBe('Agenda');
    expect(normalizeDescription('<p>Agenda</p><script>bad()</script>')).toBe('<p>Agenda</p>');
  });
});

describe('writing descriptions back to iCalendar', () => {
  it('keeps a plain-text description in DESCRIPTION only', () => {
    expect(descriptionContentLines('Full agenda', escape)).toEqual(['DESCRIPTION:Full agenda']);
    expect(descriptionContentLines(null, escape)).toEqual([]);
  });

  it('writes markup as a text DESCRIPTION plus an HTML X-ALT-DESC', () => {
    const lines = descriptionContentLines('<p>Plan</p><p>Next</p>', escape);
    expect(lines).toEqual(['DESCRIPTION:Plan\\nNext', 'X-ALT-DESC;FMTTYPE=text/html:<p>Plan</p><p>Next</p>']);
  });

  it('round-trips a sanitized HTML description through the parser', () => {
    const html = sanitizeDescriptionHtml('<p>Plan &amp; details</p><script>hidden()</script><p>Next</p>');
    const parsed = parseCalendarEvent(wrap(descriptionContentLines(html, escape)));
    expect(parsed.description).toBe('<p>Plan &amp; details</p><p>Next</p>');
  });

  it('reads the HTML alternative of an invitation accepted from mail', () => {
    const raw = wrap(['DESCRIPTION:Plain alternative', 'X-ALT-DESC;FMTTYPE=text/html:<p>Mail <strong>body</strong></p>']);
    expect(parseCalendarEvent(raw).description).toBe('<p>Mail <strong>body</strong></p>');
  });
});
