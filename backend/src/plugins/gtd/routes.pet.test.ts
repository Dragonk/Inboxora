import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { JsonBody } from '../../test/json.js';

// GET /api/gtd/pet/:slug/{meta,sheet} ownership scoping (see petRowReadable in gtd.js):
// a pet is private iff its row carries is_custom (provenance written by importPet,
// migrations/0031) AND the requester's recomputed customPetSlug doesn't match — slug
// shape alone never decides, so a public pet whose slug starts with custom- stays
// readable. db + index.js are stubbed; requireAuth is a passthrough that injects a
// session, with the userId switchable per request via an x-test-user header so owner
// vs. non-owner reads can share one running app.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: req.headers['x-test-user'] || '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071' };
    next();
  },
}));
vi.mock('../../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));
// POST /pet/import delegates the validation + storage work to importPet; stub just that
// (keeping customPetSlug / decodeUploadedSheet / getPetMeta / getPetSheet real for the
// scoping tests + the import route's decode step) so the tests below can drive the route's
// error-code → status mapping in isolation.
vi.mock('./gtdPet.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, importPet: vi.fn() };
});

import express from 'express';
import { query as __mock_query } from '../../services/db.js';
import { customPetSlug as __mock_customPetSlug, importPet as __mock_importPet } from './gtdPet.js';
import gtdRoutes from './routes.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);
const customPetSlug = vi.mocked(__mock_customPetSlug);
const importPet = vi.mocked(__mock_importPet);

// Must match the requireAuth mock's default userId above.
const OWNER_ID = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
const OTHER_ID = '00000000-0000-4000-8000-000000000001';
const OWNER_SLUG = customPetSlug(OWNER_ID);

const OWNER_PET_ROW = { slug: OWNER_SLUG, display_name: 'My Pet', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' }, is_custom: true };
const BUILTIN_PET_ROW = { slug: 'steve-jobs', display_name: 'Steve Jobs', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' }, is_custom: false };
// A public pet whose slug happens to start with custom- : stored is_custom false, so it
// must stay readable by everyone (provenance beats slug shape).
const CUSTOM_PREFIX_PUBLIC_ROW = { slug: 'custom-cat', display_name: 'Custom Cat', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' }, is_custom: false };
const META_ROWS = { [OWNER_SLUG]: OWNER_PET_ROW, 'steve-jobs': BUILTIN_PET_ROW, 'custom-cat': CUSTOM_PREFIX_PUBLIC_ROW };

// The pet now reads from generic plugin storage (plugin_data). Map the fixture rows to that
// shape: is_custom → visibility ('private' = custom), and the metadata lives in `value`.
function metaRow(r) {
  return { key: r.slug, owner_id: null, value: { displayName: r.display_name, descriptor: r.descriptor }, visibility: r.is_custom ? 'private' : 'public' };
}
function blobRow(isCustom) {
  return { blob: Buffer.from('fake-sheet-bytes'), blob_mime: 'image/webp', owner_id: null, visibility: isCustom ? 'private' : 'public' };
}

function stubQuery() {
  query.mockImplementation(async (sql, params) => {
    const slug = params?.[1]; // storage keys are (plugin_id, key) → the pet slug is params[1]
    if (sql.startsWith('SELECT key, owner_id, value, visibility FROM plugin_data')) {
      return { rows: META_ROWS[slug] ? [metaRow(META_ROWS[slug])] : [] };
    }
    if (sql.startsWith('SELECT blob, blob_mime, owner_id, visibility FROM plugin_data')) {
      return { rows: META_ROWS[slug] ? [blobRow(META_ROWS[slug].is_custom)] : [] };
    }
    return { rows: [] };
  });
}

function buildApp() {
  const app = express();
  app.use(express.json()); // POST /pet/import reads a JSON body
  app.use('/api/gtd', gtdRoutes);
  return app;
}

const petMeta = (slug, userId) => fetch(`${base}/api/gtd/pet/${slug}/meta`, {
  headers: userId ? { 'x-test-user': userId } : {},
});
const petSheet = (slug, userId) => fetch(`${base}/api/gtd/pet/${slug}/sheet`, {
  headers: userId ? { 'x-test-user': userId } : {},
});
const petImport = (body) => fetch(`${base}/api/gtd/pet/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
// A base64 payload decodeUploadedSheet accepts, so the import route reaches importPet.
const VALID_SHEET_B64 = Buffer.from('fake-spritesheet-bytes').toString('base64');

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  stubQuery();
  importPet.mockReset();
});

describe('GET /api/gtd/pet/:slug/{meta,sheet} — custom pet ownership scoping', () => {
  it('lets the owner read their own custom pet meta + sheet', async () => {
    const metaRes = await petMeta(OWNER_SLUG, OWNER_ID);
    expect(metaRes.status).toBe(200);
    expect((await metaRes.json()) as JsonBody).toEqual({ slug: OWNER_SLUG, displayName: 'My Pet', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' } });

    const sheetRes = await petSheet(OWNER_SLUG, OWNER_ID);
    expect(sheetRes.status).toBe(200);
    expect(sheetRes.headers.get('content-type')).toBe('image/webp');
  });

  it("404s a different authenticated user reading someone else's custom pet (never 403 — no existence leak)", async () => {
    const metaRes = await petMeta(OWNER_SLUG, OTHER_ID);
    expect(metaRes.status).toBe(404);
    expect(((await metaRes.json()) as JsonBody).error).toMatch(/not found/i);

    const sheetRes = await petSheet(OWNER_SLUG, OTHER_ID);
    expect(sheetRes.status).toBe(404);
  });

  it('keeps a public pet whose slug merely starts with custom- readable by anyone (provenance beats slug shape)', async () => {
    const metaRes = await petMeta('custom-cat', OTHER_ID);
    expect(metaRes.status).toBe(200);
    expect(((await metaRes.json()) as JsonBody).slug).toBe('custom-cat');

    const sheetRes = await petSheet('custom-cat', OTHER_ID);
    expect(sheetRes.status).toBe(200);
  });

  it('never leaks the is_custom flag in the meta response', async () => {
    const metaRes = await petMeta(OWNER_SLUG, OWNER_ID);
    expect(Object.keys((await metaRes.json()) as JsonBody).sort()).toEqual(['descriptor', 'displayName', 'slug']);
  });

  it('keeps built-in pet slugs readable by any authenticated user, unchanged', async () => {
    const metaRes = await petMeta('steve-jobs', OTHER_ID);
    expect(metaRes.status).toBe(200);
    expect(((await metaRes.json()) as JsonBody).slug).toBe('steve-jobs');

    const sheetRes = await petSheet('steve-jobs', OWNER_ID);
    expect(sheetRes.status).toBe(200);
  });
});

// The route maps a coded validation error (any Error carrying a `.code` — BAD_SLUG,
// BAD_IMAGE, TOO_LARGE, …) to a 400 that surfaces that error's message, and anything
// uncoded to a generic 500 (import never touches the network).
describe('POST /api/gtd/pet/import — error mapping', () => {
  it('decodes the sheet and returns the imported pet on success (200)', async () => {
    importPet.mockResolvedValueOnce({ slug: 'custom-abc', displayName: 'My Pet', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' } });
    const res = await petImport({ petJson: '{}', sheet: VALID_SHEET_B64 });
    expect(res.status).toBe(200);
    expect((await res.json()) as JsonBody).toEqual({ slug: 'custom-abc', displayName: 'My Pet', descriptor: { cols: 8, rows: 1, frameW: 32, frameH: 32, frameCount: 8, staticFrame: 0, hover: { start: 0, count: 8 }, source: 'declared' } });
    // The route decodes the base64 sheet to bytes and passes the pet.json text through verbatim.
    const arg = importPet.mock.calls[0][0];
    expect(Buffer.isBuffer(arg.sheet)).toBe(true);
    expect(arg.petJsonText).toBe('{}');
  });

  it("maps a coded validation error to 400, surfacing that error's message", async () => {
    importPet.mockRejectedValueOnce(Object.assign(new Error('Spritesheet is not a recognised image'), { code: 'BAD_IMAGE' }));
    const res = await petImport({ petJson: '{}', sheet: VALID_SHEET_B64 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonBody).error).toBe('Spritesheet is not a recognised image');
  });

  it('maps an uncoded failure to 500 (import never touches the network)', async () => {
    importPet.mockRejectedValueOnce(new Error('DB write failed'));
    const res = await petImport({ petJson: '{}', sheet: VALID_SHEET_B64 });
    expect(res.status).toBe(500);
    expect(((await res.json()) as JsonBody).error).toBe('Failed to import pet');
  });

  it('rejects a missing petJson/sheet with 400 before calling importPet', async () => {
    const res = await petImport({ sheet: VALID_SHEET_B64 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonBody).error).toMatch(/petJson and sheet are required/i);
    expect(importPet).not.toHaveBeenCalled();
  });

  it('rejects an undecodable sheet with 400 before calling importPet', async () => {
    const res = await petImport({ petJson: '{}', sheet: 'data:image/png' }); // no comma → decode returns null
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonBody).error).toMatch(/could not be decoded/i);
    expect(importPet).not.toHaveBeenCalled();
  });
});
