/** Server-owned request identity for in-process MCP domain dispatch, never set from headers. */
const trustedUsers = new WeakMap<object, string>();
export function setTrustedRequestUser(request: object, userId: string): void { trustedUsers.set(request, userId); }
export function trustedRequestUser(request: object): string | undefined { return trustedUsers.get(request); }
