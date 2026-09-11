import { describe, expect, it, vi } from 'vitest';
import { backfillRichContactFields } from './contactRichBackfill.js';

describe('backfillRichContactFields', () => {
  it('denormalizes existing rich vCard data without overwriting the raw vCard', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'contact-1', vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nTITLE:Director\r\nURL:https://example.test\r\nEND:VCARD\r\n' }] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };

    await expect(backfillRichContactFields(client)).resolves.toBe(1);
    expect(client.query.mock.calls[0][0]).toContain('rich_fields_backfilled_at IS NULL');
    expect(client.query.mock.calls[1][0]).toContain('rich_fields_backfilled_at = NOW()');
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE contacts SET'), [
      'Director', null, null, JSON.stringify([{ value: 'https://example.test', type: 'other' }]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 'contact-1',
    ]);
  });
});
