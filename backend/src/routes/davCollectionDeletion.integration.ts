/** Real HTTP routes, PostgreSQL and a synthetic localhost DAV provider.
 * Run: node --import tsx --test --test-concurrency=1 src/routes/davCollectionDeletion.integration.ts
 * Supply all DB_* settings for a dedicated *_test database with migration 0159 applied.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import session from 'express-session';
import 'express-async-errors';

// Check the caller's database before importing db.ts, which has production defaults.
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const) {
  assert.ok(process.env[key], `Explicit ${key} is required for synthetic DAV route tests`);
}
assert.match(process.env.DB_NAME ?? '', /^[a-zA-Z0-9_]+_test$/, 'A dedicated *_test database is required');
assert.match(process.env.DB_PORT ?? '', /^\d{1,5}$/);
assert.ok(Number(process.env.DB_PORT) > 0 && Number(process.env.DB_PORT) <= 65535);
process.env.ENCRYPTION_KEY ??= '11'.repeat(32);
const { pool, query } = await import('../services/db.js');
const { encrypt } = await import('../services/encryption.js');
const { invalidateConnectionPolicyCache } = await import('../services/connectionPolicy.js');
const { syncUser } = await import('../services/carddavSync.js');
const { syncCalendarSource } = await import('../services/externalCalendarSync.js');
const { readDavSyncSnapshot } = await import('../services/davSyncSnapshot.js');
const { default: calendarRouter } = await import('./calendar.js');
const { default: contactsRouter } = await import('./contacts.js');

type Kind = 'calendar' | 'addressbook';
type Remote = { kind: Kind; path: string; missing: boolean; unbind: boolean; supportsDelete: boolean; deleteStatus: number; deleteRemoves: boolean; dropDelete: boolean; journalStatusAtDelete?: string };
type Projection = { id: string; name: string; sourceId: string; remote: Remote; kind: Kind };
type Listed = { id: string; deletion?: { supported: boolean; reason?: string } };
const xmlEnvelope = (body: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
const xmlResponse = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const resourceType = (kind?: Kind) => `<d:resourcetype><d:collection/>${kind === 'calendar' ? '<cal:calendar/>' : kind === 'addressbook' ? '<c:addressbook/>' : ''}</d:resourcetype>`;
const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:route-person\r\nFN:Route Person\r\nEMAIL:route@example.invalid\r\nEND:VCARD\r\n';
const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Inboxora//Synthetic route//EN\r\nBEGIN:VEVENT\r\nUID:route-event\r\nDTSTAMP:20260901T120000Z\r\nDTSTART:20260929T120000Z\r\nDTEND:20260929T130000Z\r\nSUMMARY:Route Event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function count(table: string, column: string, id: string): Promise<number> {
  assert.match(table, /^[a-z_]+$/); assert.match(column, /^[a-z_]+$/);
  const result = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column}=$1`, [id]);
  return result.rows[0].n;
}
async function fixture() {
  const userId = randomUUID(), foreignUserId = randomUUID();
  const remotes = new Map<string, Remote>();
  const calls: Array<{ method: string; path: string }> = [];
  const provider = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? '';
    calls.push({ method, path });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = Buffer.concat(chunks).toString('utf8');
    const remote = remotes.get(path);
    const children = [...remotes.values()].filter(value => value.path.slice(0, value.path.lastIndexOf('/', value.path.length - 2) + 1) === path);
    const xml = (value: string, status = 207) => { res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(value); };
    if (remote?.missing) { res.writeHead(404); res.end(); return; }
    if (method === 'DELETE' && remote) {
      const journal = await query<{ status: string }>('SELECT status FROM dav_collection_operations WHERE user_id=$1 AND source_id=$2 AND kind=$3', [userId, path.split('/')[1], remote.kind]);
      remote.journalStatusAtDelete = journal.rows[0]?.status;
      if (remote.deleteRemoves) remote.missing = true;
      if (remote.dropDelete) { req.socket.destroy(); return; }
      xml(remote.deleteStatus === 207 ? xmlEnvelope('<d:response><d:href>child</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>') : '', remote.deleteStatus);
      return;
    }
    if (method === 'REPORT' && remote) {
      const props = `<d:getetag>"route-etag"</d:getetag>${remote.kind === 'calendar' ? `<cal:calendar-data><![CDATA[${ical}]]></cal:calendar-data>` : `<c:address-data><![CDATA[${vcard}]]></c:address-data>`}`;
      xml(xmlEnvelope(xmlResponse(`${path}${remote.kind === 'calendar' ? 'event.ics' : 'person.vcf'}`, props)));
      return;
    }
    if (method === 'PROPFIND' && (remote || children.length)) {
      if (req.headers.depth === '1' && children.length) {
        xml(xmlEnvelope(xmlResponse(path, resourceType()) + children.filter(value => !value.missing).map(value => xmlResponse(value.path, resourceType(value.kind) + `<d:displayname>${value.path}</d:displayname>`)).join('')));
        return;
      }
      const rights = remote ?? children[0];
      const props = body.includes('current-user-principal') ? `<d:current-user-principal><d:href>${path}</d:href></d:current-user-principal>`
        : body.includes('addressbook-home-set') ? `<c:addressbook-home-set><d:href>${path}</d:href></c:addressbook-home-set>`
          : `${resourceType(remote?.kind)}<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write-content/></d:privilege>${rights.unbind ? '<d:privilege><d:unbind/></d:privilege>' : ''}</d:current-user-privilege-set><d:supported-method-set><d:supported-method name="PROPFIND"/>${rights.supportsDelete ? '<d:supported-method name="DELETE"/>' : ''}</d:supported-method-set>`;
      xml(xmlEnvelope(xmlResponse(path, props)));
      return;
    }
    res.writeHead(404); res.end();
  });
  const providerOrigin = await listen(provider);
  await query('INSERT INTO users(id,username) VALUES($1,$2),($3,$4)', [userId, `dav-http-${userId}`, foreignUserId, `dav-http-${foreignUserId}`]);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'synthetic-localhost-session-only', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.session.userId = req.header('x-synthetic-user') ?? userId; next(); });
  app.use('/api/calendar', calendarRouter);
  app.use('/api/contacts', contactsRouter);
  const api = createServer(app);
  const apiOrigin = await listen(api);
  async function add(kind: Kind): Promise<Projection> {
    const sourceId = randomUUID();
    const parent = `/${sourceId}/`;
    const path = `${parent}collection/`;
    const remote: Remote = { kind, path, missing: false, unbind: true, supportsDelete: true, deleteStatus: 204, deleteRemoves: true, dropDelete: false };
    remotes.set(path, remote);
    if (kind === 'calendar') {
      await query("INSERT INTO calendar_import_sources(id,user_id,kind,url,username,password,display_name,url_fingerprint) VALUES($1,$2,'caldav',$3,'synthetic',$4,$5,$6)", [sourceId, userId, encrypt(providerOrigin + path), encrypt('synthetic-password'), `Calendar ${sourceId}`, createHash('sha256').update(providerOrigin + path).digest('hex')]);
      const result = await syncCalendarSource(userId, sourceId);
      assert.equal(result.ok, true, JSON.stringify(result));
    } else {
      await query("INSERT INTO user_integrations(id,user_id,provider,label,config) VALUES($1,$2,'carddav',$3,$4::jsonb)", [sourceId, userId, `Book ${sourceId}`, JSON.stringify({ serverUrl: providerOrigin + parent, username: 'synthetic', password: encrypt('synthetic-password'), dupMode: 'separate' })]);
      const result = await syncUser(userId, sourceId);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    const table = kind === 'calendar' ? 'calendars' : 'address_books';
    const result = await query<{ id: string; name: string }>(`SELECT id,name FROM ${table} WHERE user_id=$1 AND external_url=$2`, [userId, kind === 'calendar' ? `source:${sourceId}` : providerOrigin + path]);
    assert.equal(result.rows.length, 1);
    const { id, name } = result.rows[0];
    await query(`UPDATE ${table} SET dav_mode='read_only' WHERE id=$1`, [id]);
    assert.equal((await readDavSyncSnapshot(kind === 'calendar' ? 'calendar' : 'contacts', id, userId, null)).resources.length, 1);
    return { id, name, sourceId, remote, kind };
  }
  const collectionPath = (kind: Kind) => kind === 'calendar' ? '/api/calendar/calendars' : '/api/contacts/address-books';
  async function remove(projection: Projection, overrides: Record<string, unknown> = {}, requestUser = userId) {
    return fetch(`${apiOrigin}${collectionPath(projection.kind)}/${projection.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-synthetic-user': requestUser }, body: JSON.stringify({ confirmName: projection.name, idempotencyKey: `intent-${projection.id}`, ...overrides }) });
  }
  async function list(kind: Kind, capabilities = false): Promise<Listed[]> {
    const response = await fetch(`${apiOrigin}${collectionPath(kind)}${capabilities ? '?includeDeletionCapabilities=true' : ''}`);
    assert.equal(response.status, 200);
    const data = await response.json() as { calendars?: Listed[]; addressBooks?: Listed[] };
    return (kind === 'calendar' ? data.calendars : data.addressBooks) ?? [];
  }
  return { userId, foreignUserId, calls, add, remove, list, apiOrigin, close: async () => { await close(api); await close(provider); await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId, foreignUserId]]); } };
}
async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(body && typeof body === 'object' && !Array.isArray(body));
  return body as Record<string, unknown>;
}
async function assertRetained(projection: Projection) {
  assert.equal(await count(projection.kind === 'calendar' ? 'calendars' : 'address_books', 'id', projection.id), 1);
  assert.equal(await count(projection.kind === 'calendar' ? 'calendar_events' : 'contacts', projection.kind === 'calendar' ? 'calendar_id' : 'address_book_id', projection.id), 1);
}
async function assertCleaned(projection: Projection, userId: string) {
  const tables = projection.kind === 'calendar' ? [['calendars', 'id'], ['calendar_events', 'calendar_id'], ['calendar_occurrences', 'calendar_id'], ['calendar_sync_changes', 'calendar_id'], ['integration_collections', 'local_calendar_id']]
    : [['address_books', 'id'], ['contacts', 'address_book_id'], ['contact_sync_changes', 'address_book_id'], ['integration_collections', 'local_address_book_id']];
  for (const [table, column] of tables) assert.equal(await count(table, column, projection.id), 0, `${table} cleaned`);
  assert.deepEqual(await readDavSyncSnapshot(projection.kind === 'calendar' ? 'calendar' : 'contacts', projection.id, userId, null), { status: 'missing', token: '', resources: [] });
}
before(async () => {
  await query("INSERT INTO system_settings(key,value) VALUES('allow_private_hosts','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  invalidateConnectionPolicyCache();
});
after(async () => { await pool.end(); });

for (const kind of ['calendar', 'addressbook'] as const) {
  test(`${kind}: ordinary list has no DAV capability IO; settings opts in and isolates capability errors`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const a = await f.add(kind), broken = await f.add(kind);
    if (kind === 'calendar') await query('UPDATE calendar_import_sources SET password=$2 WHERE id=$1', [broken.sourceId, 'enc:v1:invalid']);
    else await query("UPDATE user_integrations SET config=jsonb_set(config,'{password}','\"enc:v1:invalid\"'::jsonb) WHERE id=$1", [broken.sourceId]);
    f.calls.length = 0;
    assert.equal((await f.list(kind)).find(row => row.id === a.id)?.deletion, undefined);
    assert.equal(f.calls.length, 0);
    const listed = await f.list(kind, true);
    assert.equal(listed.find(row => row.id === a.id)?.deletion?.supported, true);
    assert.equal(listed.find(row => row.id === broken.id)?.deletion?.supported, false);
    assert.ok(listed.find(row => row.id === broken.id)?.deletion?.reason);
    assert.ok(f.calls.some(call => call.method === 'PROPFIND' && call.path === a.remote.path));
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  });

  test(`${kind}: exact-name, intent, UUID and owner validation reject before DAV IO`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close); const a = await f.add(kind); f.calls.length = 0;
    for (const confirmName of [`${a.name} `, a.name.toUpperCase(), '', undefined]) {
      assert.equal((await f.remove(a, { confirmName })).status, 400);
    }
    for (const idempotencyKey of ['', ' ', 'x'.repeat(201), undefined]) assert.equal((await f.remove(a, { idempotencyKey })).status, 400);
    assert.equal((await f.remove({ ...a, id: 'not-a-uuid' })).status, 400);
    assert.equal((await f.remove(a, {}, f.foreignUserId)).status, 404);
    assert.equal((await f.remove({ ...a, id: randomUUID() })).status, 404);
    assert.equal(f.calls.length, 0);
    await assertRetained(a);
  });

  for (const denial of ['parent-unbind', 'supported-method', 'read-only', 'provider-403'] as const) {
    test(`${kind}: ${denial} refusal preserves projection`, { timeout: 20_000 }, async t => {
      const f = await fixture(); t.after(f.close); const a = await f.add(kind);
      if (denial === 'parent-unbind') a.remote.unbind = false;
      if (denial === 'supported-method') a.remote.supportsDelete = false;
      if (denial === 'read-only') await query(`UPDATE integration_collections SET user_access='read_only' WHERE ${kind === 'calendar' ? 'local_calendar_id' : 'local_address_book_id'}=$1`, [a.id]);
      if (denial === 'provider-403') { a.remote.deleteStatus = 403; a.remote.deleteRemoves = false; }
      f.calls.length = 0;
      if (denial !== 'provider-403') {
        const capability = (await f.list(kind, true)).find(row => row.id === a.id)?.deletion;
        assert.equal(capability?.supported, false); assert.ok(capability.reason);
      }
      const response = await f.remove(a);
      assert.equal(response.status, 403); assert.equal((await jsonObject(response)).state, 'failed');
      assert.equal(f.calls.filter(call => call.method === 'DELETE').length, denial === 'provider-403' ? 1 : 0);
      await assertRetained(a);
    });
  }

  for (const outcome of [202, 207, 'network'] as const) {
    test(`${kind}: DELETE ${outcome} returns unresolved; same-intent CHECK only reads before confirmed cleanup`, { timeout: 20_000 }, async t => {
      const f = await fixture(); t.after(f.close); const a = await f.add(kind), unrelated = await f.add(kind);
      if (outcome === 'network') a.remote.dropDelete = true; else a.remote.deleteStatus = outcome;
      a.remote.deleteRemoves = false; f.calls.length = 0;
      const first = await f.remove(a);
      assert.equal(first.status, 202);
      const firstBody = await jsonObject(first); assert.equal(firstBody.state, 'outcome_unknown'); assert.ok(firstBody.operationId);
      await assertRetained(a); await assertRetained(unrelated);
      assert.equal(a.remote.journalStatusAtDelete, 'pending', 'durable journal exists before outbound DELETE');
      assert.equal((await query('SELECT status FROM dav_collection_operations WHERE id=$1', [firstBody.operationId])).rows[0]?.status, 'pending');
      const beforeCheck = f.calls.length;
      const check = await f.remove(a);
      assert.equal(check.status, 202); assert.equal((await jsonObject(check)).operationId, firstBody.operationId);
      assert.ok(f.calls.slice(beforeCheck).some(call => call.method === 'PROPFIND' && call.path === a.remote.path));
      assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
      await assertRetained(a);
      a.remote.missing = true;
      const resolved = await f.remove(a);
      assert.equal(resolved.status, 200); assert.equal((await jsonObject(resolved)).state, 'confirmed');
      await assertCleaned(a, f.userId); await assertRetained(unrelated);
      assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
      assert.equal(f.calls.filter(call => call.path === unrelated.remote.path).length, 0);
    });
  }

  test(`${kind}: credential replacement cannot resolve a previous uncertain intent`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close); const a = await f.add(kind);
    a.remote.deleteStatus = 202; a.remote.deleteRemoves = false;
    const first = await f.remove(a); assert.equal(first.status, 202);
    const receipt = await jsonObject(first);
    if (kind === 'calendar') await query('UPDATE calendar_import_sources SET password=$2 WHERE id=$1', [a.sourceId, encrypt('replacement-synthetic-password')]);
    else await query("UPDATE user_integrations SET config=jsonb_set(config,'{password}',to_jsonb($2::text)) WHERE id=$1", [a.sourceId, encrypt('replacement-synthetic-password')]);
    a.remote.missing = true; f.calls.length = 0;
    const check = await f.remove(a); assert.equal(check.status, 202);
    const outcome = await jsonObject(check);
    assert.equal(outcome.state, 'outcome_unknown'); assert.equal(outcome.operationId, receipt.operationId);
    assert.equal(f.calls.length, 0, 'replacement credentials cannot perform reconciliation');
    await assertRetained(a);
    assert.equal((await query('SELECT status FROM dav_collection_operations WHERE id=$1', [receipt.operationId])).rows[0]?.status, 'pending');
  });

  test(`${kind}: confirmed DELETE cleans once; owned completed journal replays without a projection or provider IO`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close); const a = await f.add(kind), unrelated = await f.add(kind);
    f.calls.length = 0;
    const first = await f.remove(a); assert.equal(first.status, 200);
    const receipt = await jsonObject(first); assert.equal(receipt.state, 'confirmed'); assert.ok(receipt.operationId);
    await assertCleaned(a, f.userId); await assertRetained(unrelated);
    assert.equal(a.remote.journalStatusAtDelete, 'pending', 'durable journal exists before outbound DELETE');
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.equal((await query('SELECT status FROM dav_collection_operations WHERE id=$1', [receipt.operationId])).rows[0]?.status, 'completed');
    f.calls.length = 0;
    const replay = await f.remove(a); assert.equal(replay.status, 200);
    assert.equal((await jsonObject(replay)).operationId, receipt.operationId);
    assert.equal((await f.remove(a, {}, f.foreignUserId)).status, 404);
    assert.equal((await f.remove({ ...a, id: randomUUID() })).status, 404);
    assert.equal(f.calls.length, 0);
  });
}

test('calendar source disconnect remains a local detach and sends no provider DELETE', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.add('calendar'); f.calls.length = 0;
  const response = await fetch(`${f.apiOrigin}/api/calendar/sources/${a.sourceId}`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.equal(await count('calendars', 'id', a.id), 0);
  assert.equal(a.remote.missing, false);
  assert.equal(f.calls.length, 0);
  assert.equal(await count('dav_collection_operations', 'local_id', a.id), 0);
});

test('local calendar and address-book deletion retain HTTP 204 semantics without DAV IO', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const calendar = await query<{ id: string }>("INSERT INTO calendars(user_id,owner_user_id,name,source) VALUES($1,$1,'Local route calendar','local') RETURNING id", [f.userId]);
  const book = await query<{ id: string }>("INSERT INTO address_books(user_id,name,source) VALUES($1,'Local route book','local'),($1,'Surviving local book','local') RETURNING id", [f.userId]);
  assert.equal((await fetch(`${f.apiOrigin}/api/calendar/calendars/${calendar.rows[0].id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmName: 'Local route calendar' }) })).status, 204);
  assert.equal((await fetch(`${f.apiOrigin}/api/contacts/address-books/${book.rows[0].id}`, { method: 'DELETE' })).status, 204);
  assert.equal(f.calls.length, 0);
});
