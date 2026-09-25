import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The per-account provider diagnostics.
 *
 * The section exists so a live acceptance round is not guesswork: it says which connection authorized the
 * mailbox, whether each feature is authorized and what it is missing, when each feature last succeeded and
 * what its last error was. It is collapsed by default, it is read from the server for **one** account, and it
 * must never carry a credential — that is the part worth pinning, because a diagnostics screen is exactly
 * where a token tends to leak "just for debugging".
 */

const services = new URL('./AccountProviderServices.tsx', import.meta.url);
const api = new URL('../utils/api.ts', import.meta.url);

test('the diagnostics section is collapsible and reads one account from the server', async () => {
  const source = await readFile(services, 'utf8');

  assert.match(source, /data-testid="account-diagnostics-toggle"/);
  assert.match(source, /aria-expanded=\{diagnosticsOpen\}/);
  assert.match(source, /data-testid="account-diagnostics"/);
  // Collapsed until asked for: the card's job is the actions.
  assert.match(source, /const \[diagnosticsOpen, setDiagnosticsOpen\] = useState\(false\)/);
  // One coherent request carries both capabilities and diagnostics for this account.
  assert.match(source, /api\.accountProviderStatus\(accountId\)/);
  assert.doesNotMatch(source, /api\.accountProviderDiagnostics\(accountId\)/);
  assert.doesNotMatch(source, /api\.accountProviderFeatures\(accountId\)/);
  assert.match(source, /setFeatures\(data\); setDiagnostics\(data\.diagnostics\)/);
});

test('every promised line is rendered per feature', async () => {
  const source = await readFile(services, 'utf8');

  for (const testId of ['account-diagnostics-connection', 'account-diagnostics-connection-status']) {
    assert.ok(source.includes(`data-testid="${testId}"`), `${testId} is missing`);
  }
  // One block per feature, keyed by a stable slug rather than by the translated label.
  assert.match(source, /data-testid=\{`account-diagnostics-\$\{slug\}`\}/);
  for (const slug of ["diagnosticsFeature('mail'", "diagnosticsFeature('calendar'", "diagnosticsFeature('contacts'"]) {
    assert.ok(source.includes(slug), `${slug} is not rendered`);
  }

  // Mail: transport, authorization, missing scopes, last success, last error, cursor, push and schedule.
  assert.match(source, /transportLabel\(diagnostics\.mail\.transport\)/);
  assert.match(source, /diagnostics\.mail\.cursorPresent/);
  // OBS-03: the push line comes from the full push state per resource, not from the shorthand capability text —
  // "Push: available" must not be shown for a channel that is not subscribed or is not delivering.
  assert.match(source, /const pushSummary = \(push: AccountPushDiagnostic\)/);
  assert.match(source, /pushSummary\(diagnostics\.push\.mail\)/);
  assert.match(source, /pushSummary\(diagnostics\.push\.calendar\)/);
  assert.match(source, /pushSummary\(diagnostics\.push\.contacts\)/);
  assert.match(source, /push\.subscription === 'active'/);
  assert.match(source, /push\.lastErrorCode \|\| push\.subscription === 'failed'/);
  assert.match(source, /diagnostics\.mail\.scheduler/);
  // Calendar and contacts: collections and push.
  assert.match(source, /diagnostics\.calendar\.collections/);
  assert.match(source, /diagnostics\.contacts\.collections/);
  // A missing scope is listed by name, because that is the actionable part.
  assert.match(source, /data-testid=\{`account-diagnostics-missing-\$\{slug\}`\}/);
  assert.match(source, /feature\.missingScopes\.join\(', '\)/);
  // An error is shown as its code.
  assert.match(source, /data-testid=\{`account-diagnostics-error-\$\{slug\}`\}/);
});

test('the diagnostics model has no field for a credential', async () => {
  const source = await readFile(services, 'utf8');

  // The declared shape: only identifiers, states, scope names, counts and times.
  const start = source.indexOf('export interface AccountProviderDiagnostics');
  const end = source.indexOf('interface Props', start);
  const model = source.slice(start, end);
  for (const forbidden of ['token', 'secret', 'password', 'credential', 'authorization', 'refreshToken']) {
    assert.ok(!model.toLowerCase().includes(forbidden.toLowerCase()), `the diagnostics model declares ${forbidden}`);
  }

  // And nothing in the rendered section prints one either.
  const rendered = source.slice(source.indexOf('data-testid="account-diagnostics"'));
  for (const forbidden of ['accessToken', 'refreshToken', 'clientSecret', 'encrypted']) {
    assert.ok(!rendered.includes(forbidden), `the diagnostics section renders ${forbidden}`);
  }
});

test('the client calls the coherent per-account provider status endpoint', async () => {
  const source = await readFile(api, 'utf8');
  assert.match(source, /accountProviderStatus: \(accountId: string\) =>/);
  assert.match(source, /\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/provider-status/);
});

test('a service row separates authorization from synchronization', async () => {
  const source = await readFile(services, 'utf8');

  // The four states, in the order they are decided: not connected, a current failure, connected, pending.
  assert.match(source, /if \(!feature\?\.authorized\) return t\('admin\.accounts\.services\.notConnected'\)/);
  assert.match(source, /if \(feature\.syncErrorCode\) return t\('admin\.accounts\.services\.syncFailed', \{ code: feature\.syncErrorCode \}\)/);
  assert.match(source, /if \(feature\.synchronized === true\) return t\('admin\.accounts\.services\.connected'\)/);
  assert.match(source, /return t\('admin\.accounts\.services\.syncPending'\)/);

  // A grant with a failed run can never render as "not connected": authorization is established first. A failure
  // that arrived after an earlier success must not be masked by that success either, so the failure branch is
  // decided before the connected one (OBS-02).
  const notConnectedAt = source.indexOf("admin.accounts.services.notConnected");
  const failedAt = source.indexOf("admin.accounts.services.syncFailed");
  const connectedAt = source.indexOf("admin.accounts.services.connected");
  assert.ok(notConnectedAt !== -1 && failedAt !== -1 && connectedAt !== -1);
  assert.ok(notConnectedAt < failedAt, 'authorization must be decided before the failure state');
  assert.ok(failedAt < connectedAt, 'a current failure must be decided before a past success');

  // The model carries the three synchronisation fields, and the row exposes them for the tests and for a
  // reader that wants to know whether a run has completed.
  for (const field of ['synchronized', 'syncPending', 'syncErrorCode']) {
    assert.ok(source.includes(`${field}?:`), `the feature model does not declare ${field}`);
  }
  assert.match(source, /data-testid=\{`account-service-status-\$\{label\.toLowerCase\(\)\}`\}/);
  assert.match(source, /data-synchronized=\{connected && feature\?\.synchronized === true \? 'true' : 'false'\}/);
});

test('the card reacts only to its own account, from its own origin', async () => {
  const source = await readFile(services, 'utf8');

  // The listener exists, checks the origin, and matches the account before doing anything.
  assert.match(source, /window\.addEventListener\('message', onMessage\)/);
  assert.match(source, /if \(event\.origin !== window\.location\.origin\) return;/);
  assert.match(source, /if \(typeof data\.accountId !== 'string' \|\| data\.accountId !== accountId\) return;/);
  assert.match(source, /return \(\) => window\.removeEventListener\('message', onMessage\)/);

  // On a success for this account: the notice is cleared and both reads are refreshed, so the row changes
  // without a page reload.
  assert.match(source, /setNotice\(null\);\s*\n\s*setError\(null\);\s*\n\s*load\(\);\s*\n\s*reload\(\);/);
});

test('the popup hands the opener the result it needs, and no credential', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');

  assert.match(app, /type: 'oauth_success'/);
  assert.match(app, /purpose: params\.get\('purpose'\)/);
  assert.match(app, /accountId: params\.get\('accountId'\)/);
  assert.match(app, /authorized: params\.get\('authorized'\) === '1'/);
  assert.match(app, /synchronized: params\.get\('synchronized'\) === '1'/);
  assert.match(app, /syncErrorCode: params\.get\('syncErrorCode'\)/);
  // The message is addressed to this origin, so another window cannot receive it.
  assert.match(app, /window\.location\.origin\);/);
  // Nothing about a credential travels with it.
  const block = app.slice(app.indexOf("type: 'oauth_success'"), app.indexOf('window.location.origin);', app.indexOf("type: 'oauth_success'")));
  for (const forbidden of ['token', 'secret', 'connectionId']) {
    assert.ok(!block.includes(forbidden), `the handoff carries ${forbidden}`);
  }
});

test('a failed consent says so on the card that started it', async () => {
  const source = await readFile(services, 'utf8');

  // The live report was "I click Connect, choose the account, and nothing happens": the popup posted
  // `oauth_error`, the card only listened for success, and the notice stayed up with no reason shown.
  assert.match(source, /if \(data\.type === 'oauth_error'\) \{/);
  assert.match(source, /setError\(typeof data\.error === 'string'/);
  assert.match(source, /setNotice\(null\);[\s\S]{0,200}setError\(/);
  // And a successful consent clears a previous failure rather than leaving it on screen.
  assert.match(source, /if \(data\.type !== 'oauth_success'\) return;/);
  assert.match(source, /setNotice\(null\);\s*\n\s*setError\(null\);/);
});
