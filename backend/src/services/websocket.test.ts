import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));
import { setupWebSocket } from './websocket.js';

type UpgradeRequest = {
  headers: { origin?: string };
  session?: { userId?: string; locked?: boolean } | null;
};

type SessionNext = (err?: unknown) => void;

type FakeResponse = {
  getHeader: (name: string) => unknown;
  setHeader: (name: string, value: string) => void;
  end: () => void;
};

type SessionMiddleware = (req: UpgradeRequest, res: FakeResponse, next: SessionNext) => void;

type ImapManager = { connectAllForUser: (userId: string) => Promise<void> };

type WebSocketLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  readyState: number;
  userId: string | undefined;
  _diagCounted: boolean | undefined;
};

class TestWebSocket implements WebSocketLike {
  readonly close = vi.fn<(code?: number, reason?: string) => void>();
  readonly terminate = vi.fn<() => void>();
  readonly send = vi.fn<(data: string) => void>();
  readyState = 1;
  userId: string | undefined;
  _diagCounted: boolean | undefined;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      this.#listeners.set(event, [listener]);
      return;
    }
    listeners.push(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) return;
    for (const listener of listeners) listener(...args);
  }
}

class TestWebSocketServer {
  readonly #connectionListeners: Array<(ws: WebSocketLike, req: UpgradeRequest) => void> = [];

  on(event: 'connection', listener: (ws: WebSocketLike, req: UpgradeRequest) => void): void {
    this.#connectionListeners.push(listener);
  }

  connect(ws: WebSocketLike, req: UpgradeRequest): void {
    for (const listener of this.#connectionListeners) listener(ws, req);
  }
}

function createImapManager(): ImapManager {
  return { connectAllForUser: vi.fn<(userId: string) => Promise<void>>().mockResolvedValue(undefined) };
}

function setup(sessionMiddleware: SessionMiddleware, manager: ImapManager) {
  const wss = new TestWebSocketServer();
  const ws = new TestWebSocket();
  setupWebSocket(wss, sessionMiddleware, manager);
  wss.connect(ws, { headers: {}, session: { userId: 'u1' } });
  return { ws, manager };
}
afterEach(() => vi.restoreAllMocks());
describe('WebSocket failure recovery', () => {
  it('absorbs transport errors even while session lookup is pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws } = setup(() => {}, createImapManager());
    expect(() => ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });
  it('allows the browser to retry a session-store outage', () => {
    const manager = createImapManager();
    const { ws } = setup((_req, _res, next) => next(new Error('Redis unavailable')), manager);
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('does not authenticate a socket closed during session lookup', () => {
    let finish: SessionNext | undefined;
    const manager = createImapManager();
    const { ws } = setup((_req, _res, next) => { finish = next; }, manager);
    ws.readyState = 3;
    if (finish === undefined) throw new Error('session middleware did not run');
    finish();
    expect(ws.send).not.toHaveBeenCalled();
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('handles a database failure during account reconnect without an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      connectAllForUser: vi.fn<(userId: string) => Promise<void>>().mockRejectedValue(new Error('database unavailable')),
    });
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('WebSocket account reconnect failed:', 'database unavailable');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });
});
