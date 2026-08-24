# CE v2 — Post-upstream semantic reconciliation report

**Date**: 2026-08-24
**Branch**: `feat/threading-v2-final-completion`
**Merge baseline**: `cbaa12c`

## Exact SHAs

- **UPSTREAM_HEAD**: `c1e53df6667bbff8f273186d462a8281c759594c`
- **FINAL_HEAD**: `4ba201c8aeb40822958bb7b5ec1322b793734ca5`
- **ahead/behind vs upstream**: 134 ahead / 0 behind
- **MailFlow**: 3.2.4
- **0002_subject_threading.sql**: `973d8533345fc8214d41e49ab1b4d6dd5f7fa8af`, byte-identical with upstream

## Reconciled findings

### Copy/reinsert paths

`RELOCATE_COPY_COLS` is now a shared leaf projection in `backend/src/utils/relocateColumns.js`.
It contains all physical-copy columns verified against migrations, including:

- `logical_message_id`
- `conversation_id`
- `conversation_user_id`
- `canonical_message_id`
- provider message/thread/namespace fields
- threading reason/confidence/algorithm version
- raw Thread-Index/Thread-Topic/header evidence
- `automated_series_mode`
- upstream delivery/sender/plugin metadata

Excluded intentionally: `id`, `synced_at`, `row_version`, generated columns.

The projection is used by:

- UIDPLUS archive/move/trash paths in `routes/mail.js`;
- IMAP `insertCopiedSibling()`;
- associated regression tests.

`insertCopiedSibling()` previously had a drifting hand-maintained list and now uses the shared projection.

### List scope

Fixed `GET /conversations` so folder/account-filtered rows derive unread, star, latest, attachment and logical-message preview state from the same visible physical-copy scope. Hidden copies in other folders/accounts no longer leak into visible row state.

Added `conversations.listScope.test.js`.

### Provider and Sent ingest

- Outlook Thread-Index root identity is normalized consistently between live-shaped and persisted-shaped data.
- Gmail strong provider thread identity remains provider-scoped.
- Partial Sent/repair envelopes are merged with the persisted physical row before provider metadata and own-identity resolution.
- Sent `References` / `In-Reply-To` flow remains preserved through the existing `upsertSentMessageRecord()` → CE persistence path.
- Existing primary/alias/delivery-address reply identity logic remains in use.

### Subject-only grouping

The active CE decision engine has no subject-only merge path. Added adversarial unit coverage for 100 unrelated `Test`/`Re: Test` messages: every item remains a `new-root` without RFC/provider/parent evidence. Upstream subject fallback remains legacy-only behavior.

### UUID validation

CE routes reuse upstream `uuidParam` for conversation, logical-message, override and rebuild-job route parameters. Malformed UUIDs return 400 before SQL casts.

### Frontend interaction audit

- `useSelection` is shared by legacy `MessageList` and CE `ConversationList`.
- CE reader uses `newestCopy(actionTarget)` and passes the selected logical/copy context to body and copy-aware actions.
- Shared `MessageBodyRenderer` is used for reader HTML policy.
- Existing upstream ThreadRow/mobile/archive/triage behavior remains intact in legacy mode.

## Test results on FINAL_HEAD

- Backend: **92 files, 1246 tests, 0 failures**
- Frontend: **1777 tests, 0 failures**
- Backend lint: **clean**
- Frontend lint: **clean**
- Plugin boundary lint: **clean**
- Frontend build: **success, 2.43s**
- i18n: previously green at **1390 tests, 0 failures**; no locale files changed after that gate
- Focused provider/CE tests: **179 tests, 0 failures**

## PostgreSQL / Playwright / CI gates

Not falsely marked green. They remain pending because this execution environment has:

- Docker binary present but Docker daemon/socket unavailable;
- local PostgreSQL socket accepting connections but no usable test credentials/database for this user.

Therefore the following require the GitHub exact-SHA workflows:

- fresh latest-upstream schema → CE migrations;
- populated latest-upstream upgrade → CE migrations;
- real CE PostgreSQL integration;
- rebuild dry-run/write/second-write idempotency and checksum;
- real tenancy/security/race/performance gates;
- Playwright mocked and real-app desktop/mobile gates;
- 2×2 preference matrix.

Workflow files are present and configured to assert exact SHA, including:

- `conversation-v2-postgres-integration.yml`
- `conversation-v2-playwright.yml`
- `conversation-v2-real-app-playwright.yml`
- `ci.yml`

## Known P0/P1/P2

### P0

- None identified in the reviewed code paths.

### P1

1. Real PostgreSQL and Playwright workflows still need to execute on FINAL_HEAD.
2. Non-PL locales use EN placeholders for the newly added CE keys; PL is complete.
3. Exact real-app verification of Sent live update and all copy scopes remains a CI/browser gate.
4. Performance evidence for 10k/50k/100k physical copies remains pending.

### P2

1. Old development worktrees/branches remain and should be cleaned separately.
2. Full provider-specific translation parity beyond PL remains future work.
3. PostgreSQL test credentials/environment need to be supplied by CI or a controlled test database.

## Constraints respected

- No r3-01…r3-08 changes.
- No upstream PR.
- No merge into upstream/main.
- No production deploy.
- No independent final approval.
