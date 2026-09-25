import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { auditSource } from '../../scripts/i18n-source.ts';
import { interpolationVariables } from '../../scripts/i18n-interpolation.ts';

test('interpolation audit rejects malformed tokens and detects lost variables', () => {
  assert.deepEqual(interpolationVariables('{{provider}}: {{count, number}} {{- label}}'), ['count', 'label', 'provider']);
  assert.throws(() => interpolationVariables('{{provider}} {{service}'), /Malformed/);
  assert.throws(() => interpolationVariables('service}}'), /Malformed/);
  assert.notDeepEqual(interpolationVariables('{{provider}}: {{failed}}'), interpolationVariables('{{provider}}'));
});

// Exact, reviewed non-language tokens only. No baselines of untranslated copy.
const technical: Record<string, readonly string[]> = {
  'components/AdminPanel.tsx': ['mx.google.com', 'email', 'v', 'Inboxora', 'CardDAV', 'CalDAV', 'BETA', ': · : IMAP/SMTP', '/auth/oidc//callback'],
  'components/CalendarSubscriptionsSettings.tsx': ['https://example.com/calendar.ics', 'https://calendar.example.com/dav'],
  'components/CommandPalette.tsx': ['Esc'],
  'components/ComposeModal.tsx': ['B', 'I', 'U', 'S', 'A', 'https://...'],
  'components/ContactsBooksManager.tsx': ['vCard'],
  'components/ContactsPage.tsx': ['email@example.com', 'https://example.com', 'matrix:@name:example.com'],
  'components/LoginPage.tsx': ['Inboxora'],
  'components/LogoMark.tsx': ['Inboxora'],
  'components/MailApp.tsx': ['Inboxora'],
  'components/RichTextEditor.tsx': ['B', 'I', 'U', 'S'],
  'components/Sidebar.tsx': ['Inboxora'],
  'components/SignatureEditor.tsx': ['B', 'I', 'U', 'S'],
  'plugins/gtd/GtdSettings.tsx': ['BETA'],
};

test('source audit catches text, conditional attributes, messages and missing conditional keys', () => {
  const source = `<><span>nowa funkcja</span><button title={yes ? 'Edit HTML' : 'Back'}>{'OK'}</button><input placeholder='Find…'/>{t(flag ? 'one' : 'two')}{i18n.t('three')}{props.t('four')}</>;
    confirm('Delete?'); setError('Bad input');`;
  const result = auditSource('fixture.tsx', source);
  assert.deepEqual(result.keys, ['four', 'one', 'three', 'two']);
  assert.deepEqual(result.findings.map(item => item.text), ['nowa funkcja', 'Edit HTML', 'Back', 'OK', 'Find…', 'Delete?', 'Bad input']);
});

test('source audit ignores comments, translated copy and technical syntax, not short or parenthesized labels', () => {
  const result = auditSource('fixture.tsx', `// t('not.a.key')
    <><style>{'@keyframes spin {}'}</style><svg><path d="M1 2" /></svg><a href="/api/example">{t('link')}</a><span>&lt; &gt; &nbsp;</span><option>None (port 25)</option></>`);
  assert.deepEqual(result.keys, ['link']);
  assert.deepEqual(result.findings.map(item => item.text), ['None (port 25)']);
});

test('source audit catches notification templates and toolbar helper tooltips', () => {
  const result = auditSource('fixture.tsx', 'addNotification({title: "Update", body: `Downloaded ${version}`, actionLabel: ok ? "Install" : "Cancel"}); tb(active, "Bold", callback, icon);');
  assert.deepEqual(result.findings.map(item => item.text), ['Update', 'Downloaded', 'Install', 'Cancel', 'Bold']);
});

test('source audit follows constant aliases and respects parameter shadowing', () => {
  const result = auditSource('fixture.tsx', `const title = 'Untranslated'; const alias = title; const key = 'new.feature';
    function Good(title: string) { return <h1>{title}</h1>; }
    function Bad() { return <><h1>{alias}</h1>{t(key)}</>; }`);
  assert.deepEqual(result.keys, ['new.feature']);
  assert.deepEqual(result.findings.map(item => item.text), ['Untranslated']);
});

test('locale catalogs contain only non-empty string leaves, not nulls or arrays', () => {
  const directory = fileURLToPath(new URL('./', import.meta.url));
  function check(value: unknown, path: string) {
    if (typeof value === 'string') { assert.ok(value.trim(), `Empty translation: ${path}`); return; }
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid translation value: ${path}`);
    for (const [key, child] of Object.entries(value)) check(child, `${path}.${key}`);
  }
  const catalogs = readdirSync(directory).filter(file => file.endsWith('.json'));
  assert.ok(catalogs.includes('en.json') && catalogs.includes('pl.json'), 'Expected primary catalogs');
  for (const file of catalogs) check(JSON.parse(readFileSync(join(directory, file), 'utf8')), file);
});

test('CI and publishers run the translation gate before artifact publication', () => {
  const workflow = (name: string) => readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  assert.match(workflow('ci'), /run: npm run test:i18n/);
  for (const name of ['publish', 'release']) {
    const source = workflow(name);
    const gate = source.indexOf('uses: ./.github/actions/translation-gate');
    assert.ok(gate >= 0 && gate < source.indexOf('uses: docker/build-push-action'), `${name} must gate before pushing images`);
  }
  assert.equal((workflow('publish-apps').match(/run: npm run test:i18n/g) ?? []).length, 2, 'desktop and Android artifacts must both be gated');
  const action = readFileSync(new URL('../../../.github/actions/translation-gate/action.yml', import.meta.url), 'utf8');
  assert.match(action, /run: npm run test:i18n/);
  assert.doesNotMatch(action, /continue-on-error/);
});

test('first-party UI has no unreviewed hardcoded user-visible literals', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const findings: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'locales' || entry.name === '__fixtures__') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        const file = relative(root, full).replaceAll('\\', '/');
        for (const finding of auditSource(full, readFileSync(full, 'utf8')).findings) {
          if (!technical[file]?.includes(finding.text)) findings.push(`${file}:${finding.line} ${finding.kind}: ${finding.text}`);
        }
      }
    }
  }
  walk(root);
  assert.deepEqual(findings, [], `User-visible text must use i18n:\n${findings.join('\n')}`);
});
