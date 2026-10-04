import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';

const httpsRequestMock = vi.hoisted(() => vi.fn());
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return { ...actual, request: httpsRequestMock };
});

// oidc.ts imports the application entry point for imapManager. Mock it before
// loading the route so this unit test never boots Redis or other app services.
vi.mock('../index.js', () => ({ imapManager: {} }));

import { makeInsecureFetch } from './oidc.js';

describe('makeInsecureFetch', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // We will handle routes based on req.url
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          res.end(JSON.stringify({
            method: req.method,
            headers: req.headers,
            body
          }));
        });
      } else if (req.url === '/delay') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('delayed');
        }, 100);
      } else if (req.url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Send exactly 1MB + 1 byte
        const chunk = Buffer.alloc(1024 * 1024 + 1, 'a');
        res.end(chunk);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('handles basic GET and POST requests', async () => {
    const fetchFn = makeInsecureFetch();

    // Test GET
    const resGet = await fetchFn(`http://localhost:${port}/echo`, {
      method: 'GET',
      headers: { 'X-Custom-Header': 'test-value' }
    });
    expect(resGet.status).toBe(200);
    const dataGet = await resGet.json() as any;
    expect(dataGet.method).toBe('GET');
    expect(dataGet.headers['x-custom-header']).toBe('test-value');

    // Test POST
    const resPost = await fetchFn(`http://localhost:${port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    });
    expect(resPost.status).toBe(200);
    const dataPost = await resPost.json() as any;
    expect(dataPost.method).toBe('POST');
    expect(dataPost.body).toBe('{"hello":"world"}');
  });

  it('respects AbortSignal to cancel requests', async () => {
    const fetchFn = makeInsecureFetch();
    const controller = new AbortController();

    const fetchPromise = fetchFn(`http://localhost:${port}/delay`, {
      signal: controller.signal
    });

    controller.abort();

    await expect(fetchPromise).rejects.toThrow();
  });

  it('rejects responses that exceed the size limit', async () => {
    const fetchFn = makeInsecureFetch();
    await expect(fetchFn(`http://localhost:${port}/large`)).rejects.toThrow('OIDC response is too large');
  });

  it('uses https.request with rejectUnauthorized: false for HTTPS URLs', async () => {
    httpsRequestMock.mockImplementationOnce((_options: unknown, _callback: unknown) => {
      const mockReq = {
        on: (event: string, cb: (error: Error) => void) => {
          if (event === 'error') setTimeout(() => cb(new Error('mock error')), 0);
          return mockReq;
        },
        end: () => {},
        write: () => {},
        destroy: () => {},
      };
      return mockReq;
    });

    const fetchFn = makeInsecureFetch();
    await expect(fetchFn('https://example.com/test')).rejects.toThrow('mock error');

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    const optionsArg = httpsRequestMock.mock.calls[0][0] as import('https').RequestOptions;
    expect(optionsArg.hostname).toBe('example.com');
    expect(optionsArg.rejectUnauthorized).toBe(false);
  });

});
