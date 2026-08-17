# MailFlow Conversation Engine v2 — Quality Gates Status

Updated: 2026-08-17

## Truth branch
- Branch: `feat/threading-v2-integration-live`
- Current integration HEAD before this continuation: `61228ed5c9e37133dedf27ecfd4be1962b169ede`.
- Backup tag: `threading-v2-integration-live-61228ed`.
- Backup branch: `backup/threading-v2-integration-live-61228ed-20260817112013`.
- No merge to `main`/`upstream`; no upstream PR.

## Exact-SHA CI truth
The previously successful run `32023725619` tested `9e3a051`, not `61228ed`; therefore it is not a valid final gate for `61228ed`.

## Required remaining work
- Commit workflow rename/concurrency and run it on the exact final integration HEAD.
- Add real full-write-from-start rebuild idempotency with data checksums.
- Complete manual override enforcement and route tests.
- Complete provider fixtures/discovery for Gmail, Outlook and generic/Fastmail.
- Add real race, security, performance/EXPLAIN, E2E 2x2 and screenshots.
- Verify EN/FR/PL; existing repository locales are EN/FR/ES/DE/RU/ZH/IT, so Polish requires explicit implementation or a documented scope decision.
- Only after all gates are green create the linear `-r3` stack and PR descriptions.

## Exact known issue discovered
`git diff upstream/main -- backend/migrations/0002_subject_threading.sql` is non-empty on the current branch. The historical migration must be restored exactly; repair belongs in a new migration. Do not proceed to final stack until this is fixed and verified.

## Next steps
1. Restore `0002_subject_threading.sql` exactly to `upstream/main` and add a separate repair migration.
2. Run backend/frontend quality gates locally.
3. Commit integration fixes.
4. Run hosted PostgreSQL workflow on exact resulting HEAD and download artifacts/checksums.
5. Perform subagent review, resolve P0/P1.
6. Create/verify final `-r3` stack only after green integration.
