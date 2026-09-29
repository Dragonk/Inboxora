/** Synthetic PostgreSQL + localhost DAV lifecycle regressions.
 * Run with Node's test runner (not Vitest): node --import tsx --test --test-concurrency=1 src/services/davCollectionLifecycle.integration.ts
 * Requires explicit DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD for a dedicated *_test database.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

// Validate before importing application modules: db.ts otherwise supplies defaults
// that could select a non-test database. Never replace caller-supplied DB settings.
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const) {
  assert.ok(process.env[key], `Explicit ${key} is required for synthetic DAV integration tests`);
}
assert.match(process.env.DB_NAME ?? '', /^[a-zA-Z0-9_]+_test$/, 'Refusing a database without a dedicated _test name');
assert.match(process.env.DB_PORT ?? '', /^\d{1,5}$/, 'DB_PORT must be an explicit TCP port');
assert.ok(Number(process.env.DB_PORT) >= 1 && Number(process.env.DB_PORT) <= 65535, 'DB_PORT is outside the valid TCP range');
process.env.ENCRYPTION_KEY ??= '11'.repeat(32);
const { pool, query } = await import('./db.js');
const { runMigrations } = await import('./migrations.js');
const { encrypt } = await import('./encryption.js');
const { invalidateConnectionPolicyCache } = await import('./connectionPolicy.js');
const { syncUser } = await import('./carddavSync.js');
const { readDavSyncSnapshot } = await import('./davSyncSnapshot.js');
const { syncCalendarSource } = await import('./externalCalendarSync.js');
const { deleteRemoteDavCalendarCollection, deleteRemoteDavAddressBookCollection, getRemoteDavCollectionDeleteCapability, captureDavSourceFence, withDavSourceProjection } = await import('./davCollectionLifecycle.js');

const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:synthetic-person\r\nFN:Synthetic Person\r\nEMAIL:person@example.invalid\r\nEND:VCARD\r\n';
const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//DAV test//EN\r\nBEGIN:VEVENT\r\nUID:synthetic-event\r\nDTSTAMP:20260901T120000Z\r\nDTSTART:20260929T120000Z\r\nDTEND:20260929T130000Z\r\nSUMMARY:Synthetic event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const envelope = (body: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
const response = (href: string, properties: string, status = 200) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Forbidden'}</d:status></d:propstat></d:response>`;
const collectionProps = (kind: 'addressbook' | 'calendar' | 'home') => `<d:resourcetype><d:collection/>${kind === 'addressbook' ? '<c:addressbook/>' : kind === 'calendar' ? '<cal:calendar/>' : ''}</d:resourcetype><d:displayname>Synthetic ${kind}</d:displayname>`;

type Collection = { resourceType?: string; kind: 'addressbook' | 'calendar'; missing: boolean; missingStatus: number; propfindStatus: number; dropReport: boolean; deleteStatus: number; deleteRemoves: boolean; reportStatus: number; partialReport: boolean; holdReport?: { entered: () => void; resume: Promise<void> } };
type Home = { collections: string[]; status: number; partial: boolean; malformed: boolean; principalHref?: string; homeSetHref?: string; holdDiscovery?: { entered: () => void; resume: Promise<void> } };
async function fixture() {
  const userId = randomUUID();
  const homes = new Map<string, Home>();
  const collections = new Map<string, Collection>();
  const calls: Array<{ method: string; path: string; authorization?: string }> = [];
  let unbind = true;
  let supportedDelete = true;
  let parentAll = false;
  let optionalMethodProperty: 'present' | 'omitted' | 'malformed' | 404 | 403 | 500 = 'present';
  let optionsStatus = 200;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    calls.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = Buffer.concat(chunks).toString('utf8');
    const home = homes.get(path);
    const collection = collections.get(path);
    const xml = (value: string, status = 207) => { res.writeHead(status, { 'Content-Type': 'application/xml', Allow: supportedDelete ? 'OPTIONS, PROPFIND, REPORT, DELETE' : 'OPTIONS, PROPFIND, REPORT' }); res.end(value); };
    if (collection?.missing) { res.writeHead(collection.missingStatus); res.end(); return; }
    if (req.method === 'DELETE' && collection) {
      if (collection.deleteRemoves) collection.missing = true;
      xml(collection.deleteStatus === 207 ? envelope(response(`${path}child`, '', 403)) : '', collection.deleteStatus);
      return;
    }
    if (req.method === 'REPORT' && collection) {
      if (collection.dropReport) { req.socket.destroy(); return; }
      const payload = envelope(response(`${path}${collection.kind === 'calendar' ? 'event.ics' : 'person.vcf'}`, `<d:getetag>"synthetic-etag"</d:getetag>${collection.kind === 'calendar' ? `<cal:calendar-data><![CDATA[${ical}]]></cal:calendar-data>` : `<c:address-data><![CDATA[${vcard}]]></c:address-data>`}`) + (collection.partialReport ? response(`${path}hidden`, '', 403) : ''));
      collection.holdReport?.entered();
      if (collection.holdReport) await collection.holdReport.resume;
      xml(payload, collection.reportStatus);
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(optionsStatus, { Allow: supportedDelete ? 'PROPFIND, REPORT, DELETE' : 'PROPFIND, REPORT' }); res.end(); return; }
    if (req.method === 'PROPFIND' && home && req.headers.depth === '1') {
      if (home.status !== 207) { res.writeHead(home.status); res.end(); return; }
      if (home.malformed) { xml('<d:multistatus'); return; }
      const snapshot = envelope(response(path, collectionProps('home')) + home.collections.filter(p => !collections.get(p)?.missing).map(p => response(p, collectionProps(collections.get(p)?.kind ?? 'addressbook'))).join('') + (home.partial ? response(`${path}hidden/`, collectionProps('addressbook'), 403) : ''));
      home.holdDiscovery?.entered();
      if (home.holdDiscovery) await home.holdDiscovery.resume;
      xml(snapshot);
      return;
    }
    if (req.method === 'PROPFIND' && (home || collection)) {
      if (collection && collection.propfindStatus !== 207) { res.writeHead(collection.propfindStatus); res.end(); return; }
      const principal = home?.principalHref ?? path;
      const methodProperty = optionalMethodProperty === 'present'
        ? `<d:supported-method-set><d:supported-method name="PROPFIND"/>${supportedDelete ? '<d:supported-method name="DELETE"/>' : ''}</d:supported-method-set>`
        : optionalMethodProperty === 'malformed' ? '<d:supported-method-set><d:supported-method/></d:supported-method-set>' : '';
      const resourceProperties = collection?.resourceType === undefined ? collectionProps(collection?.kind ?? 'home') : collection.resourceType;
      const properties = body.includes('current-user-principal')
        ? `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>`
        : body.includes('addressbook-home-set') ? `<c:addressbook-home-set><d:href>${home?.homeSetHref ?? path}</d:href></c:addressbook-home-set>`
          : `${resourceProperties}<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write-content/></d:privilege>${unbind ? '<d:privilege><d:unbind/></d:privilege>' : ''}${parentAll && home ? '<d:privilege><d:all/></d:privilege>' : ''}</d:current-user-privilege-set>${methodProperty}`;
      const optionalStatus = typeof optionalMethodProperty === 'number' && body.includes('supported-method-set')
        ? `<d:propstat><d:prop><d:supported-method-set/></d:prop><d:status>HTTP/1.1 ${optionalMethodProperty} Optional property unavailable</d:status></d:propstat>` : '';
      xml(envelope(response(path, properties).replace('</d:response>', `${optionalStatus}</d:response>`)));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await query('INSERT INTO users(id, username) VALUES($1,$2)', [userId, `dav-${userId}`]);
  function addHome(path: string) { const home: Home = { collections: [], status: 207, partial: false, malformed: false }; homes.set(path, home); return home; }
  function addCollection(path: string, kind: Collection['kind']) { const collection: Collection = { kind, missing: false, missingStatus: 404, propfindStatus: 207, dropReport: false, deleteStatus: 204, deleteRemoves: true, reportStatus: 207, partialReport: false }; collections.set(path, collection); return collection; }
  async function addressBook(homePath = '/a/') {
    const home = homes.get(homePath) ?? addHome(homePath);
    const path = `${homePath}book/`;
    const collection = addCollection(path, 'addressbook'); home.collections.push(path);
    const sourceId = randomUUID();
    await query("INSERT INTO user_integrations(id,user_id,provider,label,config) VALUES($1,$2,'carddav',$3,$4::jsonb)", [sourceId, userId, sourceId, JSON.stringify({ serverUrl: origin + homePath, username: 'synthetic', password: encrypt('synthetic-password'), dupMode: 'separate' })]);
    const result = await syncUser(userId, sourceId); assert.equal(result.ok, true, JSON.stringify(result));
    const book = await query<{ id: string }>('SELECT id FROM address_books WHERE user_id=$1 AND external_url=$2', [userId, origin + path]);
    assert.equal(book.rows.length, 1);
    await query("UPDATE address_books SET dav_mode='read_only' WHERE id=$1", [book.rows[0].id]);
    assert.equal((await readDavSyncSnapshot('contacts', book.rows[0].id, userId, null)).resources.length, 1);
    return { sourceId, id: book.rows[0].id, path, home, collection };
  }
  async function calendar(homePath = '/cal/') {
    const home = homes.get(homePath) ?? addHome(homePath);
    const path = `${homePath}calendar/`;
    const collection = addCollection(path, 'calendar'); home.collections.push(path);
    const sourceId = randomUUID();
    await query("INSERT INTO calendar_import_sources(id,user_id,kind,url,username,password,display_name,url_fingerprint) VALUES($1,$2,'caldav',$3,'synthetic',$4,$5,$6)", [sourceId, userId, encrypt(origin + path), encrypt('synthetic-password'), `Synthetic ${sourceId}`, createHash('sha256').update(origin + path).digest('hex')]);
    const result = await syncCalendarSource(userId, sourceId); assert.equal(result.ok, true, JSON.stringify(result));
    const row = await query<{ id: string }>('SELECT id FROM calendars WHERE user_id=$1 AND external_url=$2', [userId, `source:${sourceId}`]);
    assert.equal(row.rows.length, 1);
    await query("UPDATE calendars SET dav_mode='read_only' WHERE id=$1", [row.rows[0].id]);
    assert.equal((await readDavSyncSnapshot('calendar', row.rows[0].id, userId, null)).resources.length, 1);
    return { sourceId, id: row.rows[0].id, path, home, collection };
  }
  async function close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await query('DELETE FROM users WHERE id=$1', [userId]); }
  return {
    userId, origin, homes, collections, calls, addressBook, calendar, close,
    setUnbind: (value: boolean) => { unbind = value; },
    setSupportedDelete: (value: boolean) => { supportedDelete = value; },
    setParentAll: (value: boolean) => { parentAll = value; },
    setOptionalMethodProperty: (value: typeof optionalMethodProperty) => { optionalMethodProperty = value; },
    setOptionsStatus: (value: number) => { optionsStatus = value; },
  };
}

async function count(table: string, column: string, id: string) {
  assert.match(table, /^[a-z_]+$/); assert.match(column, /^[a-z_]+$/);
  const result = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table} WHERE ${column}=$1`, [id]);
  return Number(result.rows[0].n);
}
async function assertBookGone(id: string, userId: string) {
  for (const after of [null, 0]) assert.deepEqual(await readDavSyncSnapshot('contacts', id, userId, after), { status: 'missing', token: '', resources: [] });
  for (const [table, column] of [['address_books', 'id'], ['contacts', 'address_book_id'], ['contact_sync_changes', 'address_book_id']] as const) assert.equal(await count(table, column, id), 0, `${table} cleaned`);
  assert.equal(await count('integration_collections', 'local_address_book_id', id), 0, 'collection binding retired');
}
async function assertCalendarGone(id: string, userId: string) {
  for (const after of [null, 0]) assert.deepEqual(await readDavSyncSnapshot('calendar', id, userId, after), { status: 'missing', token: '', resources: [] });
  for (const [table, column] of [['calendars', 'id'], ['calendar_events', 'calendar_id'], ['calendar_occurrences', 'calendar_id'], ['calendar_sync_changes', 'calendar_id']] as const) assert.equal(await count(table, column, id), 0, `${table} cleaned`);
  assert.equal(await count('integration_collections', 'local_calendar_id', id), 0, 'collection binding retired');
}

before(async () => {
  await runMigrations();
  await query("INSERT INTO system_settings(key,value) VALUES('allow_private_hosts','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  invalidateConnectionPolicyCache();
});
after(async () => { await pool.end(); });

test('complete empty CardDAV discovery removes only the owning source and its contact journal', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = await f.addressBook('/a/'); const b = await f.addressBook('/b/');
  await query("INSERT INTO address_books(user_id,name,source) VALUES($1,'Unrelated local','local')", [f.userId]);
  assert.ok(await count('contact_sync_changes', 'address_book_id', a.id) > 0);
  const binding = await query<{ id: string }>('SELECT id FROM integration_collections WHERE local_address_book_id=$1', [a.id]);
  assert.equal(binding.rows.length, 1);
  assert.equal(await count('remote_object_links', 'collection_id', binding.rows[0].id), 1);
  a.home.collections = [];
  const result = await syncUser(f.userId, a.sourceId); assert.equal(result.ok, true, JSON.stringify(result));
  await assertBookGone(a.id, f.userId);
  assert.equal(await count('remote_object_links', 'collection_id', binding.rows[0].id), 0);
  assert.equal(await count('contacts', 'address_book_id', b.id), 1);
  assert.equal((await query("SELECT id FROM address_books WHERE user_id=$1 AND source='local'", [f.userId])).rows.length, 1);
});

for (const failure of ['partial', 'malformed', '401', '403', '500'] as const) test(`CardDAV ${failure} discovery preserves existing contents`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.home.collections = [];
  if (failure === 'partial') a.home.partial = true;
  else if (failure === 'malformed') a.home.malformed = true;
  else a.home.status = Number(failure);
  assert.equal((await syncUser(f.userId, a.sourceId)).ok, false);
  assert.equal(await count('address_books', 'id', a.id), 1);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

for (const kind of ['calendar', 'addressbook'] as const) test(`confirmed ${kind} DELETE cleans projections and preserves unrelated local data`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  await query("INSERT INTO calendars(user_id,owner_user_id,name) VALUES($1,$1,'Unrelated local')", [f.userId]);
  if (kind === 'calendar') await query("INSERT INTO calendar_occurrences(event_id,calendar_id,user_id,starts_at,ends_at) SELECT id,calendar_id,user_id,starts_at,ends_at FROM calendar_events WHERE calendar_id=$1", [a.id]);
  const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  assert.equal(f.calls.filter(c => c.method === 'DELETE' && c.path === a.path).length, 1);
  if (kind === 'calendar') await assertCalendarGone(a.id, f.userId); else await assertBookGone(a.id, f.userId);
  assert.equal((await query("SELECT id FROM calendars WHERE user_id=$1 AND name='Unrelated local'", [f.userId])).rows.length, 1);
});

for (const status of [202, 207]) test(`DELETE ${status} remains uncertain and recovers by readback without repeat DELETE`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.collection.deleteStatus = status; a.collection.deleteRemoves = false;
  const result = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(result.status, 'unknown', JSON.stringify(result)); assert.ok(result.operationId);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
  const repeated = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(repeated.status, 'unknown', JSON.stringify(repeated));
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  a.collection.missing = true;
  assert.equal((await deleteRemoteDavAddressBookCollection(f.userId, a.id)).status, 'deleted');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  await assertBookGone(a.id, f.userId);
});

for (const missing of ['unbind', 'supported-method'] as const) test(`${missing} absence refuses DELETE despite write-content`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  if (missing === 'unbind') f.setUnbind(false); else f.setSupportedDelete(false);
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, 'addressbook', a.id)).allowed, false);
  assert.equal((await deleteRemoteDavAddressBookCollection(f.userId, a.id)).status, 'refused');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

test('foreign owner and local-only resources cannot be remotely deleted', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  assert.equal((await deleteRemoteDavAddressBookCollection(randomUUID(), a.id)).status, 'not_found');
  const local = await query<{ id: string }>("INSERT INTO address_books(user_id,name) VALUES($1,'Local') RETURNING id", [f.userId]);
  const result = await deleteRemoteDavAddressBookCollection(f.userId, local.rows[0].id);
  assert.ok(result.status === 'refused' || result.status === 'not_found');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal(await count('address_books', 'id', local.rows[0].id), 1);
});

for (const kind of ['calendar', 'addressbook'] as const) test(`slow old ${kind} REPORT cannot resurrect a deleted collection`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const release = new Promise<void>(resolve => { resume = resolve; });
  a.collection.holdReport = { entered, resume: release };
  const pending = kind === 'calendar' ? syncCalendarSource(f.userId, a.sourceId) : syncUser(f.userId, a.sourceId);
  await started;
  try {
    const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
    assert.equal(result.status, 'deleted', JSON.stringify(result));
  } finally { resume(); }
  assert.equal((await pending).ok, false);
  if (kind === 'calendar') await assertCalendarGone(a.id, f.userId); else await assertBookGone(a.id, f.userId);
});

test('cross-origin discovery href never receives DAV credentials and preserves the local snapshot', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  const leaked: string[] = [];
  const sink = createServer((req, res: ServerResponse) => { leaked.push(req.headers.authorization ?? '(no authorization)'); res.writeHead(404); res.end(); });
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  t.after(async () => { sink.closeAllConnections(); await new Promise<void>((resolve, reject) => sink.close(err => err ? reject(err) : resolve())); });
  const addr = sink.address(); assert.ok(addr && typeof addr !== 'string');
  a.home.principalHref = `http://127.0.0.1:${addr.port}/steal/`;
  assert.equal((await syncUser(f.userId, a.sourceId)).ok, false);
  assert.deepEqual(leaked, []);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

for (const status of [404, 410]) test(`verified calendar ${status} retires source, projection, occurrences and DAV journal`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.calendar();
  await query("INSERT INTO calendar_occurrences(event_id,calendar_id,user_id,starts_at,ends_at) SELECT id,calendar_id,user_id,starts_at,ends_at FROM calendar_events WHERE calendar_id=$1", [a.id]);
  a.collection.missing = true; a.collection.missingStatus = status;
  await syncCalendarSource(f.userId, a.sourceId);
  await assertCalendarGone(a.id, f.userId);
  assert.equal((await query<{ enabled: boolean }>('SELECT enabled FROM calendar_import_sources WHERE id=$1', [a.sourceId])).rows[0].enabled, false);
});

for (const kind of ['calendar', 'addressbook'] as const) {
  for (const failure of ['partial', '401', '403', 'disconnect'] as const) test(`${kind} ${failure} REPORT preserves prior resource projection`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
    if (failure === 'partial') a.collection.partialReport = true;
    else if (failure === 'disconnect') a.collection.dropReport = true;
    else a.collection.reportStatus = Number(failure);
    const result = kind === 'calendar' ? await syncCalendarSource(f.userId, a.sourceId) : await syncUser(f.userId, a.sourceId);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(await count(kind === 'calendar' ? 'calendar_events' : 'contacts', kind === 'calendar' ? 'calendar_id' : 'address_book_id', a.id), 1);
  });
}

test('calendar REPORT 404 with denied readback is not authoritative collection absence', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.calendar();
  a.collection.reportStatus = 404; a.collection.propfindStatus = 403;
  assert.equal((await syncCalendarSource(f.userId, a.sourceId)).ok, false);
  assert.equal(await count('calendar_events', 'calendar_id', a.id), 1);
  assert.equal((await query<{ enabled: boolean }>('SELECT enabled FROM calendar_import_sources WHERE id=$1', [a.sourceId])).rows[0].enabled, true);
});

test('uncertain deletion with unauthorized readback preserves journal and content without redispatch', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.collection.deleteStatus = 202; a.collection.deleteRemoves = false;
  const pending = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(pending.status, 'unknown');
  a.collection.propfindStatus = 403;
  const retry = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(retry.status, 'unknown');
  assert.equal(retry.operationId, pending.operationId);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
  assert.equal((await query<{ status: string }>('SELECT status FROM dav_collection_operations WHERE id=$1', [pending.operationId])).rows[0].status, 'pending');
});

test('persisted provider confirmation recovers local cleanup after crash without any HTTP retry', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.collection.deleteStatus = 202; a.collection.deleteRemoves = false;
  const pending = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(pending.status, 'unknown');
  // The provider worker persisted confirmation, then died before the cleanup transaction.
  await query("UPDATE dav_collection_operations SET status='confirmed' WHERE id=$1", [pending.operationId]);
  a.collection.missing = true;
  const callsBeforeRecovery = f.calls.length;
  const recovered = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(recovered.status, 'deleted'); assert.equal(recovered.operationId, pending.operationId);
  assert.equal(f.calls.length, callsBeforeRecovery);
  await assertBookGone(a.id, f.userId);
  assert.equal((await query<{ status: string }>('SELECT status FROM dav_collection_operations WHERE id=$1', [pending.operationId])).rows[0].status, 'completed');
});

for (const kind of ['calendar', 'addressbook'] as const) test(`${kind} credential replacement fences an older in-flight snapshot`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const release = new Promise<void>(resolve => { resume = resolve; });
  a.collection.holdReport = { entered, resume: release };
  const pending = kind === 'calendar' ? syncCalendarSource(f.userId, a.sourceId) : syncUser(f.userId, a.sourceId);
  await started;
  try {
    if (kind === 'calendar') await query('UPDATE calendar_import_sources SET password=$2 WHERE id=$1', [a.sourceId, encrypt('new-synthetic-password')]);
    else await query("UPDATE user_integrations SET config=config || $2::jsonb WHERE id=$1", [a.sourceId, JSON.stringify({ password: encrypt('new-synthetic-password') })]);
  } finally { resume(); }
  const result = await pending;
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(await count(kind === 'calendar' ? 'calendar_events' : 'contacts', kind === 'calendar' ? 'calendar_id' : 'address_book_id', a.id), 1);
});

test('changed DAV home does not authorize pruning collections beneath the prior home', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook('/old/');
  f.homes.set('/new/', { collections: [], status: 207, partial: false, malformed: false });
  a.home.homeSetHref = '/new/';
  const result = await syncUser(f.userId, a.sourceId);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await count('address_books', 'id', a.id), 1);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

for (const kind of ['calendar', 'addressbook'] as const) test(`authoritative ${kind} sync resolves a prior uncertain deletion journal`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  a.collection.deleteStatus = 202; a.collection.deleteRemoves = false;
  const deleteCollection = () => kind === 'calendar' ? deleteRemoteDavCalendarCollection(f.userId, a.id) : deleteRemoteDavAddressBookCollection(f.userId, a.id);
  const pending = await deleteCollection(); assert.equal(pending.status, 'unknown');
  a.collection.missing = true;
  if (kind === 'calendar') await syncCalendarSource(f.userId, a.sourceId); else await syncUser(f.userId, a.sourceId);
  const recovered = await deleteCollection();
  assert.equal(recovered.status, 'deleted', JSON.stringify(recovered)); assert.equal(recovered.operationId, pending.operationId);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal((await query<{ status: string }>('SELECT status FROM dav_collection_operations WHERE id=$1', [pending.operationId])).rows[0].status, 'completed');
  if (kind === 'calendar') await assertCalendarGone(a.id, f.userId); else await assertBookGone(a.id, f.userId);
});

test('discovery snapshot cannot prune a same-source collection created after discovery began', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const release = new Promise<void>(resolve => { resume = resolve; });
  a.home.collections = []; a.home.holdDiscovery = { entered, resume: release };
  const pending = syncUser(f.userId, a.sourceId);
  await started;
  let insertedId: string;
  try {
    const inserted = await query<{ id: string }>(`INSERT INTO address_books(user_id,name,source,external_url,source_connection_id)
      SELECT user_id,'Created during discovery','carddav',$2,source_connection_id FROM address_books WHERE id=$1 RETURNING id`, [a.id, f.origin + '/a/new/']);
    insertedId = inserted.rows[0].id;
  } finally { resume(); }
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
  await assertBookGone(a.id, f.userId);
  assert.equal(await count('address_books', 'id', insertedId), 1);
});

test('discovery snapshot cannot prune a source-owned collection modified after discovery began', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const release = new Promise<void>(resolve => { resume = resolve; });
  a.home.collections = []; a.home.holdDiscovery = { entered, resume: release };
  const pending = syncUser(f.userId, a.sourceId);
  await started;
  try { await query("UPDATE address_books SET name='Newer local metadata', updated_at=clock_timestamp() WHERE id=$1", [a.id]); }
  finally { resume(); }
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await count('address_books', 'id', a.id), 1);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

for (const status of [200, 404, 410]) test(`provider DELETE ${status} confirms complete collection deletion`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.collection.deleteStatus = status;
  assert.equal((await deleteRemoteDavAddressBookCollection(f.userId, a.id)).status, 'deleted');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  await assertBookGone(a.id, f.userId);
});

for (const status of [401, 403, 405]) test(`provider DELETE ${status} refusal preserves local collection`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  a.collection.deleteStatus = status; a.collection.deleteRemoves = false;
  assert.equal((await deleteRemoteDavAddressBookCollection(f.userId, a.id)).status, 'refused');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(await count('address_books', 'id', a.id), 1);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

test('normalized legacy collection URL keeps its original book and integration binding', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  const legacyUrl = (f.origin + a.path).replace(/\/$/, '');
  const binding = await query<{ id: string }>('SELECT id FROM integration_collections WHERE local_address_book_id=$1', [a.id]);
  assert.equal(binding.rows.length, 1);
  await query('UPDATE address_books SET external_url=$2 WHERE id=$1', [a.id, legacyUrl]);
  await query('UPDATE integration_collections SET remote_id=$2 WHERE id=$1', [binding.rows[0].id, legacyUrl]);
  const result = await syncUser(f.userId, a.sourceId); assert.equal(result.ok, true, JSON.stringify(result));
  const books = await query<{ id: string }>("SELECT id FROM address_books WHERE user_id=$1 AND source='carddav'", [f.userId]);
  assert.deepEqual(books.rows.map(row => row.id), [a.id]);
  const bindings = await query<{ id: string }>('SELECT id FROM integration_collections WHERE local_address_book_id=$1', [a.id]);
  assert.deepEqual(bindings.rows.map(row => row.id), [binding.rows[0].id]);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

test('newer calendar sync claim supersedes another process snapshot before projection', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.calendar();
  const older = await captureDavSourceFence(f.userId, 'calendar', a.sourceId);
  const newer = await captureDavSourceFence(f.userId, 'calendar', a.sourceId);
  assert.notEqual(older, newer);
  await assert.rejects(withDavSourceProjection(f.userId, 'calendar', a.sourceId, older, async client => {
    await client.query("UPDATE calendar_events SET summary='Stale overwrite' WHERE calendar_id=$1", [a.id]);
  }), /superseded/);
  await withDavSourceProjection(f.userId, 'calendar', a.sourceId, newer, async client => {
    await client.query("UPDATE calendar_events SET summary='Current projection' WHERE calendar_id=$1", [a.id]);
  });
  const events = await query<{ summary: string }>('SELECT summary FROM calendar_events WHERE calendar_id=$1', [a.id]);
  assert.deepEqual(events.rows.map(row => row.summary), ['Current projection']);
});

test('identical remote URLs under distinct source identities never authorize cross-source cleanup', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  const secondSource = randomUUID();
  await query("INSERT INTO user_integrations(id,user_id,provider,label,config) VALUES($1,$2,'carddav',$3,$4::jsonb)", [secondSource, f.userId, secondSource, JSON.stringify({ serverUrl: f.origin + '/a/', username: 'another-synthetic-owner', password: encrypt('another-synthetic-password'), dupMode: 'separate' })]);
  const imported = await syncUser(f.userId, secondSource); assert.equal(imported.ok, true, JSON.stringify(imported));
  const other = await query<{ id: string }>(`SELECT ab.id FROM address_books ab JOIN source_connections sc ON sc.id=ab.source_connection_id
    WHERE sc.integration_id=$1 AND ab.external_url=$2 AND ab.user_id=$3`, [secondSource, f.origin + a.path, f.userId]);
  assert.equal(other.rows.length, 1); assert.notEqual(other.rows[0].id, a.id);
  a.home.collections = [];
  const removed = await syncUser(f.userId, a.sourceId); assert.equal(removed.ok, true, JSON.stringify(removed));
  await assertBookGone(a.id, f.userId);
  assert.equal(await count('address_books', 'id', other.rows[0].id), 1);
  assert.equal(await count('contacts', 'address_book_id', other.rows[0].id), 1);
});

for (const kind of ['calendar', 'addressbook'] as const) test(`${kind} absence under replacement credentials cannot confirm the original deletion`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  a.collection.deleteStatus = 202; a.collection.deleteRemoves = false;
  const deleteCollection = () => kind === 'calendar' ? deleteRemoteDavCalendarCollection(f.userId, a.id) : deleteRemoteDavAddressBookCollection(f.userId, a.id);
  const pending = await deleteCollection(); assert.equal(pending.status, 'unknown');
  if (kind === 'calendar') await query('UPDATE calendar_import_sources SET password=$2 WHERE id=$1', [a.sourceId, encrypt('replacement-owner-password')]);
  else await query("UPDATE user_integrations SET config=config || $2::jsonb WHERE id=$1", [a.sourceId, JSON.stringify({ password: encrypt('replacement-owner-password') })]);
  a.collection.missing = true;
  if (kind === 'calendar') await syncCalendarSource(f.userId, a.sourceId); else await syncUser(f.userId, a.sourceId);
  assert.equal(await count(kind === 'calendar' ? 'calendars' : 'address_books', 'id', a.id), 1);
  assert.equal(await count(kind === 'calendar' ? 'calendar_events' : 'contacts', kind === 'calendar' ? 'calendar_id' : 'address_book_id', a.id), 1);
  const result = await deleteCollection(); assert.equal(result.status, 'unknown', JSON.stringify(result));
  assert.equal(result.operationId, pending.operationId);
  assert.equal((await query<{ status: string }>('SELECT status FROM dav_collection_operations WHERE id=$1', [pending.operationId])).rows[0].status, 'pending');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
});

for (const kind of ['calendar', 'addressbook'] as const) test(`${kind} configured account home never permits recursive DELETE despite DELETE and parent unbind`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  const homePath = a.path.slice(0, a.path.slice(0, -1).lastIndexOf('/') + 1);
  f.homes.set('/', { collections: [homePath], status: 207, partial: false, malformed: false });
  if (kind === 'calendar') {
    await query('UPDATE calendar_import_sources SET url=$2, url_fingerprint=$3 WHERE id=$1', [a.sourceId, encrypt(f.origin + homePath), createHash('sha256').update(f.origin + homePath).digest('hex')]);
  } else {
    await query('UPDATE address_books SET external_url=$2 WHERE id=$1', [a.id, f.origin + homePath]);
  }
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, kind, a.id)).allowed, false);
  const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(result.status, 'refused', JSON.stringify(result));
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(await count(kind === 'calendar' ? 'calendar_events' : 'contacts', kind === 'calendar' ? 'calendar_id' : 'address_book_id', a.id), 1);
  assert.equal(a.collection.missing, false);
});

for (const kind of ['calendar', 'addressbook'] as const) {
  for (const invalid of ['opposite', 'missing', 'principal', 'inbox', 'outbox', 'wrong-namespace'] as const) test(`${kind} ${invalid} resource type refuses destructive capability and preserves contents`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
    const expected = kind === 'calendar' ? '<cal:calendar/>' : '<c:addressbook/>';
    const invalidType = invalid === 'opposite' ? (kind === 'calendar' ? '<c:addressbook/>' : '<cal:calendar/>')
      : invalid === 'principal' ? `${expected}<d:principal/>`
        : invalid === 'inbox' ? `${expected}<cal:schedule-inbox/>`
          : invalid === 'outbox' ? `${expected}<cal:schedule-outbox/>`
            : invalid === 'wrong-namespace' ? `<fake:${kind} xmlns:fake="urn:untrusted"/>` : '';
    a.collection.resourceType = invalid === 'missing' ? '<d:displayname>Type unavailable</d:displayname>' : `<d:resourcetype><d:collection/>${invalidType}</d:resourcetype>`;
    assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, kind, a.id)).allowed, false);
    const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
    assert.equal(await count(kind === 'calendar' ? 'calendar_events' : 'contacts', kind === 'calendar' ? 'calendar_id' : 'address_book_id', a.id), 1);
  });
}

for (const kind of ['calendar', 'addressbook'] as const) {
  for (const optionalProperty of ['omitted', 404] as const) test(`${kind} unavailable supported-method-set ${optionalProperty} uses OPTIONS DELETE with parent unbind`, { timeout: 20_000 }, async t => {
    const f = await fixture(); t.after(f.close);
    const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
    f.setOptionalMethodProperty(optionalProperty);
    assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, kind, a.id)).allowed, true);
    const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
    assert.equal(result.status, 'deleted', JSON.stringify(result));
    assert.ok(f.calls.some(call => call.method === 'OPTIONS' && call.path === a.path));
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
    if (kind === 'calendar') await assertCalendarGone(a.id, f.userId); else await assertBookGone(a.id, f.userId);
  });
}

for (const kind of ['calendar', 'addressbook'] as const) test(`${kind} explicit DAV all on parent includes unbind`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const a = kind === 'calendar' ? await f.calendar() : await f.addressBook();
  f.setUnbind(false); f.setParentAll(true);
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, kind, a.id)).allowed, true);
  const result = kind === 'calendar' ? await deleteRemoteDavCalendarCollection(f.userId, a.id) : await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  if (kind === 'calendar') await assertCalendarGone(a.id, f.userId); else await assertBookGone(a.id, f.userId);
});

for (const propertyFailure of ['malformed', 403, 500] as const) test(`supported-method-set ${propertyFailure} cannot fall back to OPTIONS or DELETE`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  f.setOptionalMethodProperty(propertyFailure);
  const callsBefore = f.calls.length;
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, 'addressbook', a.id)).allowed, false);
  const result = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.ok(result.status === 'refused' || result.status === 'unknown', JSON.stringify(result));
  assert.equal(f.calls.slice(callsBefore).filter(call => call.method === 'OPTIONS' || call.method === 'DELETE').length, 0);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

for (const optionsStatus of [401, 403, 500]) test(`OPTIONS ${optionsStatus} cannot authorize DELETE through an Allow header`, { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  f.setOptionalMethodProperty(404); f.setOptionsStatus(optionsStatus);
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, 'addressbook', a.id)).allowed, false);
  const result = await deleteRemoteDavAddressBookCollection(f.userId, a.id);
  assert.ok(result.status === 'refused' || result.status === 'unknown', JSON.stringify(result));
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});

test('OPTIONS DELETE without parent unbind cannot authorize collection deletion', { timeout: 20_000 }, async t => {
  const f = await fixture(); t.after(f.close); const a = await f.addressBook();
  f.setOptionalMethodProperty(404); f.setUnbind(false);
  assert.equal((await getRemoteDavCollectionDeleteCapability(f.userId, 'addressbook', a.id)).allowed, false);
  assert.equal((await deleteRemoteDavAddressBookCollection(f.userId, a.id)).status, 'refused');
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(await count('contacts', 'address_book_id', a.id), 1);
});
