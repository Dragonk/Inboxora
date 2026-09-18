const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function normalizeVersion(value) {
  if (!value) return null;

  const normalized = String(value).trim().replace(/^refs\/tags\//, '').replace(/^v[.]?/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Android versionCode derived from the semantic version, not from a build counter.
 *
 * Uses Google's recommended scheme `major * 1e6 + minor * 1e4 + patch * 1e2`. A build
 * counter such as `github.run_number` restarts whenever the repository is re-created or
 * moved (which is exactly what happened when the project left the MailFlow fork network),
 * and an APK whose versionCode is lower than the installed one is rejected by Android as a
 * downgrade. Deriving the code from the version keeps it stable across repositories and
 * strictly increasing along the release line.
 *
 * Pre-releases (for example `4.0.0-dev.12`) get a code below their own release and above the
 * previous one, so a pre-release can always be replaced by the release it belongs to.
 */
function computeVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(version == null ? '' : String(version));
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];

  const base = major * 1_000_000 + minor * 10_000 + patch * 100;
  return prerelease ? base - 50 : base;
}

function updateJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  json.version = version;
  if (json.packages && json.packages['']) {
    json.packages[''].version = version;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function main() {
  const requestedVersion = process.argv[2] || process.env.APP_VERSION || process.env.GITHUB_REF_NAME;
  const version = normalizeVersion(requestedVersion);

  if (!version) {
    if (requestedVersion) {
      console.error(`Invalid release tag version "${requestedVersion}". Expected a semver tag like v1.2.3.`);
      process.exit(1);
    }

    console.log('No release tag version detected; keeping package versions unchanged.');
    return;
  }

  const versionCode = computeVersionCode(version);

  updateJsonVersion(path.join(root, 'package.json'), version);
  updateJsonVersion(path.join(root, 'package-lock.json'), version);

  const buildGradlePath = path.join(root, 'packages', 'android', 'app', 'build.gradle');
  let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
  buildGradle = buildGradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
  buildGradle = buildGradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);

  fs.writeFileSync(buildGradlePath, buildGradle);

  console.log(`Prepared app package version ${version} (versionCode ${versionCode}).`);
}

if (require.main === module) {
  main();
}

module.exports = { normalizeVersion, computeVersionCode, main };
