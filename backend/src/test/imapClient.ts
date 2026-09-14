import type { ImapClient, ImapManager } from '../services/imapManager.js';

/**
 * Test double for the IMAP client: a case exercises only the few methods it uses, while the
 * manager is typed against the full ImapClient surface. \`ImapClientDouble\` merges that surface onto
 * an empty runtime object, so assigning the test parts yields the full type without an assertion
 * and leaves the caller's object untouched at runtime.
 */
interface ImapClientDouble extends ImapClient {}
class ImapClientDouble {}

export function mockImapClient<T extends object>(parts: T): ImapClient & T {
  return Object.assign(parts, new ImapClientDouble());
}

/**
 * Test double for the manager: a rule batch exercises only the two engine methods it calls, while
 * the production signature is the real class. \`ImapManagerDouble\` merges the class instance type onto
 * an empty runtime object, so assigning the test parts yields the full type without an assertion.
 */
interface ImapManagerDouble extends ImapManager {}
class ImapManagerDouble {}

export function mockImapManager<T extends object>(parts: T): ImapManager & T {
  return Object.assign(parts, new ImapManagerDouble());
}
