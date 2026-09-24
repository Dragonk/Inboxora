import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { listeningPort } from '../test/net.js';
import { buildDigestAuthorization, davAuthenticatedFetch, parseDigestChallenge } from './davHttpAuth.js';

const md5 = (value: string) => crypto.createHash('md5').update(value).digest('hex');

function parseAuthorization(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of header.replace(/^Digest\s+/i, '').matchAll(/([a-z0-9_-]+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi)) {
    out[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\([\\"])/g, '$1');
  }
  return out;
}

let server: Server;
let base = '';
let requests: Array<{ method: string; authorization: string }> = [];
let mode: 'basic' | 'digest' = 'digest';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const authorization = String(req.headers.authorization || '');
    requests.push({ method: req.method || '', authorization });
    if (mode === 'basic') {
      if (!authorization.startsWith('Basic ')) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="DAV"'); res.end(); return; }
      res.statusCode = 207; res.end('<multistatus/>'); return;
    }
    if (!authorization.startsWith('Digest ')) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Digest realm="BaikalDAV", nonce="nonce-1", algorithm=MD5, qop="auth", opaque="opaque-1"');
      res.end();
      return;
    }
    const fields = parseAuthorization(authorization);
    const expected = md5(`${md5('sam:BaikalDAV:secret')}:nonce-1:${fields.nc}:${fields.cnonce}:auth:${md5(`${req.method}:${fields.uri}`)}`);
    if (fields.username !== 'sam' || fields.response !== expected) { res.statusCode = 401; res.end(); return; }
    res.statusCode = 207;
    res.end('<multistatus/>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => new Promise<void>(resolve => server.close(() => resolve())));

describe('DAV HTTP authentication', () => {
  it('parses a Baikal-style Digest challenge', () => {
    expect(parseDigestChallenge('Digest realm="BaikalDAV", nonce="n", algorithm=MD5, qop="auth"')).toMatchObject({ realm: 'BaikalDAV', nonce: 'n', algorithm: 'MD5', qop: 'auth' });
  });

  it('builds SHA-256 Digest credentials too', () => {
    const challenge = parseDigestChallenge('Digest realm="dav", nonce="n", algorithm=SHA-256, qop="auth"')!;
    const header = buildDigestAuthorization({ challenge, method: 'PROPFIND', url: 'https://dav.example.test/cal?a=1', username: 'u', password: 'p', cnonce: 'c', nonceCount: 1 });
    expect(header).toContain('algorithm=SHA-256');
    expect(header).toContain('uri="/cal?a=1"');
  });

  it('waits for a Basic challenge before sending credentials on private HTTP', async () => {
    mode = 'basic'; requests = [];
    const response = await davAuthenticatedFetch(`${base}/dav`, { method: 'PROPFIND' }, { username: 'sam', password: 'secret' }, { allowPrivate: true });
    expect(response.status).toBe(207);
    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBe('');
    expect(requests[1].authorization).toBe(`Basic ${Buffer.from('sam:secret').toString('base64')}`);
  });

  it('replays the same DAV method after a Digest challenge', async () => {
    mode = 'digest'; requests = [];
    const response = await davAuthenticatedFetch(`${base}/remote.php/dav/calendars/sam/work/`, { method: 'REPORT', body: '<query/>', headers: { 'Content-Type': 'application/xml' } }, { username: 'sam', password: 'secret' }, { allowPrivate: true });
    expect(response.status).toBe(207);
    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBe('');
    expect(requests[1]).toMatchObject({ method: 'REPORT' });
    expect(requests[1].authorization).toMatch(/^Digest /);
  });
});
