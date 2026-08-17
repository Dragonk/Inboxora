# MailFlow Conversation Engine v2 — Integration Status

Updated: 2026-08-17

## Truth branch
- `feat/threading-v2-integration-live`
- Current HEAD is tracked locally; worktree clean.
- No merge to `main` or `upstream`; no upstream PR opened.
- Existing r2 stack/worktrees and backup refs preserved.

## Inputs
- The full primary spec file was not found on disk or in repository/worktrees.
- Only the completion-prompt fragment was available in conversation context.
- Full compliance cannot be claimed until the primary spec is recovered.

## Implemented and verified
- Conversation Engine v2 migration is preserved.
- User-scoped conversation persistence now uses serializable transactions with retry.
- Canonical Message-ID logical dedup is user-scoped, while physical copies remain account-scoped.
- Parent selection now prioritizes `In-Reply-To`, then last resolvable `References` ID.
- Unresolved references and evidence are persisted.
- Main IMAP sync and backfill call conversation persistence.
- Sent and draft metadata paths call conversation persistence.
- Gmail/Outlook/generic provider metadata is normalized through the shared adapter; Gmail BigInt values are safe.
- Conversation list API has stable timestamp+UUID cursor ordering, explicit boolean aggregation, and latest-own-reply projection.
- Conversation detail API returns authorized physical copies/body metadata under user-scoped conversation access.
- Frontend conversation list/reader are i18n-compliant; frontend lint, full test suite, i18n test and production build passed in latest run.

## Remaining blockers before final stack/review
- Persistence still needs durable retry/error recording rather than only logging failures from IMAP hook.
- Sent/draft calls need complete RFC references/provider metadata propagation and dedicated tests.
- Missing-parent reconciliation must reparent descendants when the referenced message arrives.
- Manual overrides/aliases are not yet enforced.
- Conversation components are not wired into `MailApp` behind the feature preference; they remain separately implemented.
- No rebuild/audit API with dry-run/write/resume/idempotency has been completed in this integration.
- No full DB-backed route/persistence tests, fresh/upgrade migration tests, E2E 2x2, screenshots, performance review, or production-provider verification yet.
- Full primary spec remains unavailable.

## Next steps
1. Add durable ingest failure table/retry path and missing-parent reconciliation.
2. Implement override/alias semantics and rebuild/audit/settings API.
3. Wire feature-gated conversation UI into MailApp with legacy fallback and deep links.
4. Add DB-backed API/persistence tests and provider fixtures.
5. Run full quality gates, migration fresh/upgrade, rebuild dry-run/write/resume/idempotency, provider discovery, strict/smart, API contract, E2E, security, performance, screenshots and i18n.
6. Only after all are green, create fresh linear eight-branch `-r2` stack and verify ancestry/patch-id/duplicates.
7. Produce the required final report with P0/P1 list empty and explicit no-merge/no-upstream-PR confirmation.
