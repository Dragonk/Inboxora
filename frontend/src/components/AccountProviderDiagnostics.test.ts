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
  // One request for one account, and the same account the features were read for.
  assert.match(source, /api\.accountProviderDiagnostics\(accountId\)/);
  assert.match(source, /api\.accountProviderFeatures\(accountId\)/);
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
  assert.match(source, /diagnostics\.mail\.push/);
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

test('the client calls the per-account diagnostics endpoint', async () => {
  const source = await readFile(api, 'utf8');
  assert.match(source, /accountProviderDiagnostics: \(accountId: string\) =>/);
  assert.match(source, /\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/provider-diagnostics/);
});
