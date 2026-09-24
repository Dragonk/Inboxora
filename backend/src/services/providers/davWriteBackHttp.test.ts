import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { listeningPort } from '../../test/net.js';
import { sendDavWrite } from './davWriteBack.js';
import type { DavSource } from './davWriteBack.js';

/**
 * The precondition and ETag forwarding, asserted against a real HTTP server rather than a fake
 * fetch: what matters is the bytes on the wire, because a client's optimistic-concurrency guard is
 * only worth anything if the same guard reaches the source.
 */

interface Recorded {
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base = '';
let respond: (res: ServerResponse) => void;
let recorded: Recorded[] = [];

const source = (): DavSource => ({
  kind: 'caldav',
  collectionUrl: `${base}/calendars/user/work/`,
  username: 'sam',
  password: 'secret',
  allowPrivate: true,
});

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function reset(status: number, headers: Record<string, string> = {}) {
  recorded = [];
  respond = res => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.statusCode = status;
    res.end();
  };
}

describe('sendDavWrite forwards the HTTP preconditions to the source', () => {
  it('sends the stored version as If-Match and answers a Basic challenge without preemptive plaintext credentials', async () => {
    recorded = [];
    let challenged = false;
    respond = res => {
      if (!challenged) {
        challenged = true;
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="DAV"');
        res.end();
        return;
      }
      res.statusCode = 204;
      res.setHeader('ETag', '"etag-10"');
      res.end();
    };
    const attempt = await sendDavWrite({
      method: 'PUT',
      href: `${base}/calendars/user/work/e1.ics`,
      source: source(),
      headers: { 'If-Match': '"etag-9"' },
      body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      contentType: 'text/calendar; charset=utf-8',
    });
    expect(attempt.disposition).toEqual({ kind: 'committed' });
    expect(attempt.status).toBe(204);
    expect(attempt.etag).toBe('etag-10');
    expect(recorded).toHaveLength(2);
    expect(recorded[0].headers.authorization).toBeUndefined();
    expect(recorded[1].method).toBe('PUT');
    expect(recorded[1].headers['if-match']).toBe('"etag-9"');
    expect(recorded[1].headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(recorded[1].headers.authorization).toBe(`Basic ${Buffer.from('sam:secret').toString('base64')}`);
    expect(recorded[1].body).toContain('BEGIN:VCALENDAR');
  });

  it('retries a DAV write with Digest authentication after a 401 challenge', async () => {
    recorded = [];
    let challenged = false;
    respond = res => {
      if (!challenged) {
        challenged = true;
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Digest realm="BaikalDAV", nonce="write-nonce", algorithm=MD5, qop="auth"');
        res.end();
        return;
      }
      res.statusCode = 204;
      res.setHeader('ETag', '"digest-etag"');
      res.end();
    };
    const attempt = await sendDavWrite({
      method: 'PUT', href: `${base}/calendars/user/work/digest.ics`, source: source(), headers: { 'If-Match': '"old"' }, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    });
    expect(attempt.disposition).toEqual({ kind: 'committed' });
    expect(attempt.etag).toBe('digest-etag');
    expect(recorded).toHaveLength(2);
    expect(recorded[0].headers.authorization).toBeUndefined();
    expect(recorded[1].headers.authorization).toMatch(/^Digest /);
    expect(recorded[1].headers['if-match']).toBe('"old"');
  });

  it('sends If-None-Match: * for a create and no body for a delete', async () => {
    reset(201);
    await sendDavWrite({
      method: 'PUT',
      href: `${base}/calendars/user/work/e2.ics`,
      source: source(),
      headers: { 'If-None-Match': '*' },
      body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      contentType: 'text/calendar; charset=utf-8',
    });
    expect(recorded[0].headers['if-none-match']).toBe('*');
    expect(recorded[0].headers['if-match']).toBeUndefined();

    reset(204);
    await sendDavWrite({
      method: 'DELETE',
      href: `${base}/calendars/user/work/e2.ics`,
      source: source(),
      headers: { 'If-Match': '"etag-2"' },
    });
    expect(recorded[0].method).toBe('DELETE');
    expect(recorded[0].headers['if-match']).toBe('"etag-2"');
    expect(recorded[0].body).toBe('');
  });

  it('classifies the source status, including the retryable Retry-After', async () => {
    reset(412);
    expect((await sendDavWrite({ method: 'PUT', href: `${base}/x`, source: source(), headers: {}, body: 'x' })).disposition)
      .toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' });

    reset(503, { 'Retry-After': '17' });
    expect((await sendDavWrite({ method: 'PUT', href: `${base}/x`, source: source(), headers: {}, body: 'x' })).disposition)
      .toEqual({ kind: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
  });

  it('treats a refused connection as retryable, because nothing was delivered', async () => {
    // Bind and immediately close a port so the connect is refused rather than left hanging.
    const dead = createServer();
    await new Promise<void>(resolve => { dead.listen(0, '127.0.0.1', resolve); });
    const deadBase = `http://127.0.0.1:${listeningPort(dead)}`;
    await new Promise<void>(resolve => dead.close(() => resolve()));
    const attempt = await sendDavWrite({
      method: 'PUT',
      href: `${deadBase}/x`,
      source: { ...source(), collectionUrl: deadBase },
      headers: {},
      body: 'x',
    });
    expect(attempt.disposition).toEqual({ kind: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
  });
});
