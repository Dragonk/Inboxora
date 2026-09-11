#!/usr/bin/env bash
# Verify that a reviewed task commit is actually integrated into Inboxora dev.
set -euo pipefail

usage() {
  printf 'Usage: %s <candidate-commit> [target-branch]\n' "${0##*/}" >&2
  exit 64
}

candidate="${1:-}"
target="${2:-dev}"
[[ -n "$candidate" ]] || usage

repo_root="$(git rev-parse --show-toplevel)"
expected_origin="https://github.com/Dragonk/Inboxora.git"
actual_origin="$(git -C "$repo_root" remote get-url origin)"

if [[ "$actual_origin" != "$expected_origin" ]]; then
  printf 'ERROR: unexpected origin: %s\n' "$actual_origin" >&2
  exit 65
fi

if ! git -C "$repo_root" show-ref --verify --quiet "refs/heads/$target"; then
  printf 'ERROR: target branch does not exist locally: %s\n' "$target" >&2
  exit 66
fi

if ! git -C "$repo_root" rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null; then
  printf 'ERROR: candidate is not a local commit: %s\n' "$candidate" >&2
  exit 67
fi

candidate_sha="$(git -C "$repo_root" rev-parse "${candidate}^{commit}")"
target_sha="$(git -C "$repo_root" rev-parse "$target^{commit}")"

if ! git -C "$repo_root" merge-base --is-ancestor "$candidate_sha" "$target_sha"; then
  printf 'ERROR: candidate %s is NOT integrated into %s (%s).\n' \
    "$candidate_sha" "$target" "$target_sha" >&2
  exit 1
fi

printf 'OK: candidate %s is an ancestor of %s (%s).\n' \
  "$candidate_sha" "$target" "$target_sha"
