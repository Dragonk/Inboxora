import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requireScheduledId, validateScheduledAt, validateScheduledPayload, validateTimeZone } from './scheduledMail.js';

const message = { accountId: randomUUID(), body: '<p>body</p>', bodyIsHtml: true };
describe('scheduled mail input validation', () => {
  it('preserves the precise explicit UTC instant independently of display zone', () => {
    expect(validateScheduledAt('2036-02-29T12:34:56.789Z', 0).toISOString()).toBe('2036-02-29T12:34:56.789Z');
    expect(validateScheduledAt('2036-02-29T12:34:56Z', 0).toISOString()).toBe('2036-02-29T12:34:56.000Z');
    expect(validateTimeZone('Europe/Prague')).toBe('Europe/Prague');
    expect(validateTimeZone('UTC')).toBe('UTC');
  });
  it.each(['2035-02-29T12:00:00Z', '2036-02-30T12:00:00Z', '2036-13-01T00:00:00Z',
    '2036-01-01T24:00:00Z', '2036-01-01T00:00:60Z', '2036-01-01T00:00:00',
    '2036-01-01T00:00:00+00:00', '2036-01-01', '', null, 42])('rejects invalid or non-UTC instant %s', value => {
    expect(() => validateScheduledAt(value, 0)).toThrow(expect.objectContaining({ status: 400, code: 'SCHEDULE_INVALID' }));
  });
  it('rejects past and exactly-now instants', () => {
    const now = Date.parse('2036-01-01T00:00:00Z');
    for (const value of ['2035-12-31T23:59:59Z', '2036-01-01T00:00:00Z']) expect(() => validateScheduledAt(value, now)).toThrow();
  });
  it.each(['Mars/Olympus', '', null, 42, 'x'.repeat(81)])('rejects invalid time zone %s', value => {
    expect(() => validateTimeZone(value)).toThrow();
  });
  it('whitelists nested attachment fields and preserves recipient roles without leaking injected state', () => {
    const source = { ...message, to: ['To <to@example.test>'], cc: ['cc@example.test'], bcc: ['private@example.test'],
      attachments: [{ filename: 'bytes.bin', content: 'AAH/', contentType: 'application/octet-stream', path: '/secret' }],
      forwardedAttachments: [{ messageId: randomUUID(), part: '2', accountId: randomUUID() }],
      editedSignature: 'frozen', editedSignatureIsHtml: false, subject: 'subject', lease_token: randomUUID(), user_id: randomUUID(), state: 'sent' };
    expect(validateScheduledPayload(source)).toEqual({ ...message, to: source.to, cc: source.cc, bcc: source.bcc,
      attachments: [{ filename: 'bytes.bin', content: 'AAH/', contentType: 'application/octet-stream' }],
      forwardedAttachments: [{ messageId: source.forwardedAttachments[0].messageId, part: '2' }],
      editedSignature: 'frozen', editedSignatureIsHtml: false, subject: 'subject' });
    expect(validateScheduledPayload(message)).toEqual({ ...message, to: [], cc: [], bcc: [] });
  });
  it.each([null, [], 'body', { ...message, body: null }, { ...message, bodyIsHtml: 'true' },
    { ...message, accountId: 'invalid' }, { ...message, aliasId: 'invalid' }, { ...message, subject: 7 },
    { ...message, to: 'a@example.test' }, { ...message, bcc: [null] }, { ...message, cc: Array(1001).fill('a@example.test') },
    { ...message, attachments: null }, { ...message, attachments: [null] },
    { ...message, attachments: [{ filename: ' ', content: '' }] }, { ...message, attachments: [{ filename: 'a', content: 2 }] },
    { ...message, attachments: [{ filename: 'a', content: '', contentType: 2 }] },
    { ...message, forwardedAttachments: null }, { ...message, forwardedAttachments: [{ messageId: randomUUID(), part: '' }] },
    { ...message, editedSignatureIsHtml: null }])('rejects malformed message %#', value => {
    expect(() => validateScheduledPayload(value)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('validates queue ids before database use', () => {
    expect(() => requireScheduledId(randomUUID())).not.toThrow();
    expect(() => requireScheduledId("'; DROP TABLE scheduled_mail")).toThrow();
  });
});
