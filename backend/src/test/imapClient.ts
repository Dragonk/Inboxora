import type { ImapClient, ImapManager } from '../services/imapManager.js';

/**
 * Test double for the IMAP client: a case exercises only the few methods it uses, while the
 * manager is typed against the full ImapClient surface. The cast lives here so no test needs one.
 */
export function mockImapClient<T extends object>(parts: T): ImapClient & T {
  return parts as unknown as ImapClient & T;
}


/**
 * Test double for the manager: a rule batch exercises only the two engine methods it calls, while the
 * production signature is the real class. The cast lives here so no test needs one.
 */
export function mockImapManager<T extends object>(parts: T): ImapManager & T {
  return parts as unknown as ImapManager & T;
}
