# MailFlow Conversation Engine v2 — Integration Status

Updated: 2026-08-17

## Truth branch
- `feat/threading-v2-integration-live`
- HEAD: `600d439` before the latest local IMAP hook change; current worktree has an uncommitted hook adjustment.
- No merge to `main` or `upstream`; no upstream PR opened.
- Existing r2 stack and worktrees preserved.

## Recovered inputs
- The full primary spec file was not found on disk or in the repository/worktrees.
- The completion prompt fragment was available in conversation context.
- Therefore full compliance cannot yet be claimed.

## Work completed
- New integration branch created from existing r2 integration.
- Conversation Engine v2 migration already present and preserved.
- Persistence now has transactional logical-message/conversation upsert, user-owner verification, provider mappings, parent lookup, message-ID-less body/header deduplication, aggregate refresh, and IMAP main/backfill hooks.
- Provider metadata normalized for Gmail/Outlook/generic and BigInt-safe.
- Conversation API uses authenticated user scoping and keyset cursor structure.
- Frontend list/reader components use i18n; all frontend lint/build/i18n tests passed in the latest run.

## Latest independent review — blockers still open
- List API uses invalid `MAX(boolean::int)::boolean` aggregate and needs `BOOL_OR`.
- Multi-account canonical Message-ID dedup is still account-sensitive.
- Transaction is not serializable/advisory-locked; race-safe uniqueness is missing.
- Evidence and unresolved-reference tables are not populated/reconciled.
- Parent precedence must be In-Reply-To first, then last resolvable References.
- Sent/draft paths are not yet wired to conversation persistence.
- Existing-row header refresh can leave stale conversation evidence.
- Provider metadata implementations are duplicated and namespace persistence is inconsistent.
- Detail API lacks physical message copies/body/capabilities.
- NULL timestamp cursor semantics are unsafe.
- Latest-own-reply projection is missing.
- ConversationList effect still includes object `params` dependency.
- Components are not wired into MailApp.
- Manual overrides/aliases are not enforced.
- Persistence errors are swallowed without durable retry state.

## Required next steps
1. Fix the listed P1/P0 findings before any r2 stack recreation.
2. Add DB-backed route/persistence/ingest tests and migration fresh/upgrade tests.
3. Implement rebuild/audit API with dry-run/write/resume/idempotency and durable errors.
4. Wire sent/draft ingest and MailApp feature-gated UI.
5. Add provider discovery and Gmail/Outlook/generic capability tests.
6. Add E2E 2x2, deep-link, mobile, security, performance and screenshot checks.
7. Run all quality gates and only then recreate the exact eight-branch linear `-r2` stack from green integration.
8. Produce final report with SHA/refs/DAG/patch-id/diffs/tests/migrations/rebuild/provider/API/E2E/security/performance/i18n/rollout/rollback/descriptions/limitations and empty P0/P1 list.
