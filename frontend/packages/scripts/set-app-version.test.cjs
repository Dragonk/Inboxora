const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { computeVersionCode, normalizeVersion } = require('./set-app-version.cjs');

// versionCodes published while the code was derived from the repository run counter.
const PREVIOUSLY_PUBLISHED_VERSION_CODES = [4, 7, 9];

test('normalizeVersion accepts tags and rejects non-versions', () => {
  assert.equal(normalizeVersion('v4.0.3'), '4.0.3');
  assert.equal(normalizeVersion('refs/tags/v4.0.3'), '4.0.3');
  assert.equal(normalizeVersion('4.0.0-dev.12'), '4.0.0-dev.12');
  assert.equal(normalizeVersion('dev'), null);
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion(undefined), null);
});

test('computeVersionCode follows the semantic version', () => {
  assert.equal(computeVersionCode('4.0.0'), 4000000);
  assert.equal(computeVersionCode('4.0.1'), 4000100);
  assert.equal(computeVersionCode('4.0.2'), 4000200);
  assert.equal(computeVersionCode('4.0.3'), 4000300);
  assert.equal(computeVersionCode('10.2.30'), 10023000);
  assert.equal(computeVersionCode('not-a-version'), null);
});

test('computeVersionCode increases strictly along the release line', () => {
  const codes = ['4.0.0', '4.0.1', '4.0.2', '4.0.3', '4.1.0', '5.0.0'].map(computeVersionCode);
  for (let index = 1; index < codes.length; index += 1) {
    assert.ok(codes[index] > codes[index - 1], `${codes[index]} must exceed ${codes[index - 1]}`);
  }
});

test('a release installs over every previously published build', () => {
  // Regression: 4.0.3 was published with versionCode 2, because github.run_number restarted
  // in the re-created repository, so Android rejected it as a downgrade over 4.0.2 (code 9).
  for (const previous of PREVIOUSLY_PUBLISHED_VERSION_CODES) {
    assert.ok(
      computeVersionCode('4.0.3') > previous,
      `4.0.3 must be installable over a build published with versionCode ${previous}`,
    );
  }
});

test('pre-releases stay below their own release and above the previous one', () => {
  assert.equal(computeVersionCode('4.0.0-dev.12'), 3999950);
  assert.ok(computeVersionCode('4.0.0-dev.12') < computeVersionCode('4.0.0'));
  assert.ok(computeVersionCode('4.0.0-dev.12') > computeVersionCode('3.4.0'));
  assert.ok(computeVersionCode('4.0.1-dev.3') > computeVersionCode('4.0.0'));
  assert.ok(computeVersionCode('4.0.1-dev.3') < computeVersionCode('4.0.1'));
});

test('the CLI writes the derived versionCode into build.gradle', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'inboxora-set-app-version-'));
  try {
    const scriptDir = path.join(sandbox, 'packages', 'scripts');
    const androidDir = path.join(sandbox, 'packages', 'android', 'app');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(androidDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'set-app-version.cjs'), path.join(scriptDir, 'set-app-version.cjs'));
    fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', version: '0.0.0' }));
    fs.writeFileSync(
      path.join(sandbox, 'package-lock.json'),
      JSON.stringify({ name: 'sandbox', version: '0.0.0', packages: { '': { version: '0.0.0' } } }),
    );
    fs.writeFileSync(
      path.join(androidDir, 'build.gradle'),
      'defaultConfig {\n            versionCode 1\n            versionName "4.0.0"\n        }\n',
    );

    execFileSync(process.execPath, [path.join(scriptDir, 'set-app-version.cjs'), 'v4.0.3'], { stdio: 'pipe' });

    const gradle = fs.readFileSync(path.join(androidDir, 'build.gradle'), 'utf8');
    assert.match(gradle, /versionCode 4000300\b/);
    assert.match(gradle, /versionName "4\.0\.3"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8')).version, '4.0.3');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
