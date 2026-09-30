#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:-}"
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: scripts/release.sh <version>" >&2; exit 1; }
TAG="v$VERSION"
# Version changes reach main through the release PR, never a direct push.
test -z "$(git status --porcelain)" || { echo "Commit the release preparation first." >&2; exit 1; }
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" || { echo "Check out the merged main revision first." >&2; exit 1; }
VERSION="$VERSION" node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for(const part of ['backend','frontend']) {
  const pkg=JSON.parse(readFileSync(`${part}/package.json`));
  const lock=JSON.parse(readFileSync(`${part}/package-lock.json`));
  assert.equal(pkg.version,process.env.VERSION);assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
}
JS
if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Tag already exists; it will not be moved." >&2; exit 1
fi
git tag -a "$TAG" -m "Inboxora $VERSION"
printf 'Created %s at merged main. Publish with: git push origin refs/tags/%s\n' "$TAG" "$TAG"
