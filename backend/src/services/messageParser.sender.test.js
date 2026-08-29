import { describe, it, expect } from 'vitest';
import { parseMessage } from './messageParser.js';

// The RFC 5322 Sender / IMAP ENVELOPE sender (#366) is surfaced as "via X" only when it names a
// DIFFERENT mailbox than From. Servers default ENVELOPE sender to From when the Sender header is
// absent, so parseMessage must return null unless the sender address genuinely differs — otherwise
// every ordinary message would show a spurious "via".
const msg = (envelope) => ({ uid: 1, envelope, flags: [] });

describe('parseMessage — sender ("via") extraction', () => {
  it('surfaces a distinct Sender (on-behalf-of / via)', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', address: 'boss@corp.com' }],
      sender: [{ name: 'Mailing Service', address: 'bounce@service.io' }],
    }));
    expect(p.senderEmail).toBe('bounce@service.io');
    expect(p.senderName).toBe('Mailing Service');
  });

  it('returns null when there is no Sender', async () => {
    const p = await parseMessage(msg({ from: [{ name: 'Alice', address: 'alice@example.com' }] }));
    expect(p.senderEmail).toBeNull();
    expect(p.senderName).toBeNull();
  });

  it('returns null when Sender equals From (server-defaulted, not a real via)', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      sender: [{ name: 'Alice', address: 'alice@example.com' }],
    }));
    expect(p.senderEmail).toBeNull();
    expect(p.senderName).toBeNull();
  });

  it('compares the Sender address case-insensitively', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Alice', address: 'Alice@Example.com' }],
      sender: [{ name: 'Alice', address: 'alice@example.com' }],
    }));
    expect(p.senderEmail).toBeNull();
  });

  it('keeps a distinct Sender that has no display name', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', address: 'boss@corp.com' }],
      sender: [{ address: 'svc@platform.com' }],
    }));
    expect(p.senderEmail).toBe('svc@platform.com');
    expect(p.senderName).toBe('');
  });

  it('supports the legacy mailbox/host address shape', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', mailbox: 'boss', host: 'corp.com' }],
      sender: [{ name: 'Svc', mailbox: 'svc', host: 'platform.com' }],
    }));
    expect(p.senderEmail).toBe('svc@platform.com');
    expect(p.senderName).toBe('Svc');
  });
});
