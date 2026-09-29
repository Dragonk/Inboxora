import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./db.js', () => ({ query: mocks.query }));
import { scheduledMailAttachment } from './scheduledMailPreview.js';

describe('frozen scheduled attachment reads', () => {
  const owner = randomUUID(); const id = randomUUID();
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [{ state: 'pending', revision: 7, payload: { payload: {
      attachments: [{ filename: 'exact.bin', content: 'AAH/' },
        { filename: 'untrusted.html', content: 'PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', contentType: 'text/html' }],
      forwardedAttachments: [{ messageId: randomUUID(), part: '1' }],
    } } }] });
  });
  it('reads exact materialized bytes using only the authenticated owner and no writes or provider calls', async () => {
    expect(await scheduledMailAttachment(owner, id, '0', '7')).toEqual({ filename: 'exact.bin', content: Buffer.from([0, 1, 255]) });
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT state,revision,payload FROM scheduled_mail WHERE id=$1 AND user_id=$2', [id, owner]);
    expect(await scheduledMailAttachment(owner, id, '1', '7')).toEqual({ filename: 'untrusted.html', content: Buffer.from('<script>alert(1)</script>') });
    await expect(scheduledMailAttachment(owner, id, '2', '7')).rejects.toMatchObject({ status: 404, code: 'SCHEDULE_MISSING' });
  });
  it('rejects missing and foreign rows without revealing a revision', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(scheduledMailAttachment(owner, id, '0', '7')).rejects.toMatchObject({ status: 404, code: 'SCHEDULE_MISSING' });
  });
  it('rejects stale revisions before returning an attachment at a reused index', async () => {
    await expect(scheduledMailAttachment(owner, id, '0', '6')).rejects.toMatchObject({ status: 409, code: 'SCHEDULE_CHANGED' });
  });
  it.each(['cancelled', 'dismissed', 'sent'])('rejects %s even with frozen bytes still present', async state => {
    mocks.query.mockResolvedValue({ rows: [{ state, revision: 7, payload: { payload: {
      attachments: [{ filename: 'private', content: 'AAH/' }],
    } } }] });
    await expect(scheduledMailAttachment(owner, id, '0', '7')).rejects.toMatchObject({ status: 404 });
  });
  it.each([{}, { payload: {} }, { payload: { attachments: [{ filename: 'missing bytes' }] } }])('rejects missing frozen payload %#', async payload => {
    mocks.query.mockResolvedValue({ rows: [{ state: 'pending', revision: 7, payload }] });
    await expect(scheduledMailAttachment(owner, id, '0', '7')).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    ['bad-id', '0', '7'], [id, '-1', '7'], [id, '1.1', '7'], [id, '01', '7'], [id, '1e0', '7'],
    [id, '9007199254740992', '7'], [id, '__proto__', '7'], [id, '0', '0'], [id, '0', '-1'],
    [id, '0', '1.5'], [id, '0', '01'], [id, '0', '9007199254740992'], [id, '0', undefined],
    [id, '0', ['7', '8']], [id, '0', { revision: '7' }],
  ])('rejects malformed attachment coordinates before SQL %#', async (queueId, index, revision) => {
    await expect(scheduledMailAttachment(owner, String(queueId), index, revision)).rejects.toMatchObject({ status: 400, code: 'SCHEDULE_INVALID' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
