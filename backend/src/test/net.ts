import type { Server } from 'node:http';

/**
 * Port of a listening HTTP server.
 *
 * `server.address()` is `AddressInfo | string | null`; a test that reads `.port`
 * off it is only ever talking about a TCP `AddressInfo`. Failing loudly here turns
 * a mis-bound test server into a clear error instead of an undefined URL.
 */
export function listeningPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server is not listening on a TCP port');
  }
  return address.port;
}
