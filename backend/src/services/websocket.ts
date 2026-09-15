import { recordWsConnect, recordWsDisconnect } from './diagnosticsRing.js';

// Derive the expected origin from APP_URL once at startup.
// If APP_URL is not set, origin validation is skipped — log a warning so operators know.
const ALLOWED_ORIGIN = (() => {
  try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : null; } catch { return null; }
})();
if (!ALLOWED_ORIGIN) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: APP_URL is not set in production — WebSocket connections with an Origin header will be rejected.');
  } else {
    console.warn('WARNING: APP_URL is not set — WebSocket origin validation is disabled. Set APP_URL in .env for production.');
  }
}

// The transport surface this module uses, declared structurally so both the real ws server and the
// unit test's plain EventEmitter doubles satisfy it.
interface WebSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readyState?: number;
  userId?: string;
  _diagCounted?: boolean;
}

interface WebSocketServerLike {
  on(
    event: 'connection',
    listener: (
      ws: WebSocketLike,
      req: { headers: { origin?: string }; session?: { userId?: string; locked?: boolean } | null },
    ) => void,
  ): unknown;
}

interface SessionMiddlewareLike {
  (
    req: { headers: { origin?: string }; session?: { userId?: string; locked?: boolean } | null },
    res: { getHeader(name: string): unknown; setHeader(name: string, value: string): void; end(): void },
    next: (err?: unknown) => void,
  ): void;
}

interface ImapManagerLike {
  connectAllForUser(userId: string): Promise<void>;
}

export function setupWebSocket(wss: WebSocketServerLike, sessionMiddleware: SessionMiddlewareLike, imapManager: ImapManagerLike) {
  wss.on('connection', (ws: WebSocketLike, req: { headers: { origin?: string }; session?: { userId?: string; locked?: boolean } | null }) => {
    // Transport errors can arrive during session lookup, before authentication.
    ws.on('error', (err: unknown) => {
      console.warn('WebSocket transport error:', err instanceof Error ? err.message : String(err));
      ws.terminate();
    });
    // Reject cross-origin WebSocket connections when APP_URL is configured.
    // Browsers always send Origin on WS upgrades; absence means a non-browser client.
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
      ws.close(1008, 'Forbidden');
      return;
    }
    // In production without APP_URL, reject browser connections (non-browser clients omit Origin)
    if (!ALLOWED_ORIGIN && process.env.NODE_ENV === 'production' && origin) {
      ws.close(1008, 'Forbidden');
      return;
    }

    // Parse session from upgrade request
    const fakeRes = {
      getHeader: () => {},
      setHeader: () => {},
      end: () => {}
    };

    sessionMiddleware(req, fakeRes, (err: unknown) => {
      if (ws.readyState !== 1) return;
      if (err) {
        // A temporary session-store outage should be retried, not treated as
        // invalid credentials (1008 disables automatic browser reconnects).
        ws.close(1011, 'Session unavailable');
        return;
      }
      const session = req.session;
      if (!session || !session.userId) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      const userId = session.userId;
      if (session.locked) {
        // Screen lock (#235) is server-enforced: don't stream live mail to a locked
        // session. The client closes its own socket on lock; this blocks a new one.
        ws.close(1008, 'Locked');
        return;
      }
      ws.userId = userId;
      recordWsConnect();
      ws._diagCounted = true;
      console.log(`WebSocket connected for user ${userId}`);
      ws.send(JSON.stringify({ type: 'connected' }));
      // Re-establish IMAP connections if the server restarted (skips already-connected accounts)
      imapManager.connectAllForUser(userId).catch((err: unknown) => {
        console.error('WebSocket account reconnect failed:', err instanceof Error ? err.message : String(err));
      });
    });

    ws.on('message', async (data: unknown) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore malformed client message */ }
    });

    ws.on('close', () => {
      if (ws._diagCounted) recordWsDisconnect();
      console.log(`WebSocket disconnected`);
    });
  });
}
