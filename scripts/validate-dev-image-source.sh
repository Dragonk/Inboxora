#!/usr/bin/env bash
set -euo pipefail
source_sha="${REQUESTED_SHA:-$SELECTED_SHA}"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
test "${SELECTED_REF_TYPE:-}" = 'branch'
git check-ref-format "refs/heads/$SELECTED_REF"
test "$(git rev-parse HEAD)" = "$source_sha"
git fetch origin "+refs/heads/$SELECTED_REF:refs/remotes/origin/$SELECTED_REF"
git merge-base --is-ancestor "$source_sha" "origin/$SELECTED_REF"
