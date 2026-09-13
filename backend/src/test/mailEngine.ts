import type { PluginMailEngine } from '../plugins/mailEngine.js';

/**
 * Test double for the mail engine: a hook exercises only the few methods it uses, while the
 * platform hands plugins the full bound surface. The cast lives here so no test needs one.
 */
export function mockMailEngine<T extends object>(parts: T): PluginMailEngine & T {
  return parts as unknown as PluginMailEngine & T;
}

