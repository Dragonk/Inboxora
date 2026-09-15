import type { PluginMailEngine } from '../plugins/mailEngine.js';

/**
 * Test double for the mail engine: a hook exercises only the few methods it uses, while the
 * platform hands plugins the full bound surface. \`MailEngineDouble\` merges the real surface onto an
 * empty runtime object, so assigning the test parts yields the full type without an assertion and
 * leaves the caller's object untouched at runtime.
 */
interface MailEngineDouble extends PluginMailEngine {}
class MailEngineDouble {}

export function mockMailEngine<T extends object>(parts: T): PluginMailEngine & T {
  return Object.assign(parts, new MailEngineDouble());
}
