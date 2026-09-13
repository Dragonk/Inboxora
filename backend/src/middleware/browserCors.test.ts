import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCors } from './browserCors.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(createBrowserCors({ origin: 'https://email.kmms.ovh', credentials: true }));
  app.options('/api/protected', (_req, res) => res.status(401).end());
  app.options('/carddav/', (_req, res) => res.set('DAV', '1, 2, 3, addressbook').status(200).end());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('browser CORS middleware', () => {
  it('ends browser API preflight before protected API routing', async () => {
    const response = await fetch(`${base}/api/protected`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
  });

  it('passes DAV OPTIONS to the DAV router', async () => {
    const response = await fetch(`${base}/carddav/`, { method: 'OPTIONS' });

    expect(response.status).toBe(200);
    expect(response.headers.get('dav')).toContain('addressbook');
  });
});
