#!/usr/bin/env bash
#
# Publish docs/wiki/ to the GitHub Wiki.
#
# The GitHub Wiki is a separate git repository, so the reviewed Markdown in
# docs/wiki/ is copied there in one commit. The pages link their screenshots
# through absolute raw.githubusercontent.com URLs and carry no copied images.
#
# Usage:
#   scripts/publish-wiki.sh [--branch <branch>] [--dry-run]
#
# Options:
#   --branch <branch>  Branch the Wiki screenshots link to (default: main).
#   --dry-run          Clone and stage the pages, then stop before pushing.
#
# Requirements: git, network access to the Wiki remote, and push rights to it.

set -euo pipefail

BRANCH="main"
DRY_RUN=false
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_DIR="$REPO_ROOT/docs/wiki"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)  BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$SOURCE_DIR" ]] || { echo "Missing $SOURCE_DIR" >&2; exit 1; }
[[ -f "$SOURCE_DIR/Home.md" ]] || { echo "Missing $SOURCE_DIR/Home.md" >&2; exit 1; }

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "Error: the working tree has uncommitted changes; publish reviewed content only." >&2
  exit 1
fi

REMOTE=$(git -C "$REPO_ROOT" remote get-url origin)
WIKI_REMOTE="${REMOTE%.git}.wiki.git"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Cloning $WIKI_REMOTE"
if git clone --depth 1 "$WIKI_REMOTE" "$WORK_DIR/wiki" 2>/dev/null; then
  :
else
  echo "Wiki repository is empty or does not exist yet; initialising a new one."
  git init --quiet "$WORK_DIR/wiki"
  git -C "$WORK_DIR/wiki" remote add origin "$WIKI_REMOTE"
  git -C "$WORK_DIR/wiki" checkout --quiet -b master
fi

# Replace the published pages with the reviewed source. Only Markdown is copied;
# the Wiki keeps its own history, so removals are reflected explicitly.
find "$WORK_DIR/wiki" -maxdepth 1 -name '*.md' -delete
cp "$SOURCE_DIR"/*.md "$WORK_DIR/wiki/"

# Screenshot links point at a branch of the main repository. Retarget them so a
# Wiki published from a release branch keeps working if the branch is renamed.
find "$WORK_DIR/wiki" -maxdepth 1 -name '*.md' -print0 |
  xargs -0 sed -i "s|raw.githubusercontent.com/Dragonk/Inboxora/[^/]*/media/screenshots|raw.githubusercontent.com/Dragonk/Inboxora/$BRANCH/media/screenshots|g"

# GitHub Wiki resolves pages by name, while the repository renders relative .md
# links. Strip the extension from same-page-name links so both render correctly.
find "$WORK_DIR/wiki" -maxdepth 1 -name '*.md' -print0 |
  xargs -0 sed -i -E 's|\]\(([A-Za-z0-9_.-]+)\.md\)|](\1)|g'

git -C "$WORK_DIR/wiki" add -A
if git -C "$WORK_DIR/wiki" diff --cached --quiet; then
  echo "Wiki is already up to date; nothing to publish."
  exit 0
fi

SOURCE_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
git -C "$WORK_DIR/wiki" -c user.name="Inboxora docs" -c user.email="noreply@github.com" \
  commit --quiet -m "docs(wiki): publish from $SOURCE_SHA"

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run: staged pages in $WORK_DIR/wiki (not pushed)."
  git -C "$WORK_DIR/wiki" show --stat --oneline HEAD
  exit 0
fi

git -C "$WORK_DIR/wiki" push origin HEAD
echo "Published docs/wiki/ to $WIKI_REMOTE"
