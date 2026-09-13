import type { ImapClient } from '../services/imapManager.js';

/**
 * Test double for the IMAP client: a case exercises only the few methods it uses, while the
 * manager is typed against the full ImapClient surface. The cast lives here so no test needs one.
 */
export function mockImapClient<T extends object>(parts: T): ImapClient & T {
  return parts as unknown as ImapClient & T;
}

