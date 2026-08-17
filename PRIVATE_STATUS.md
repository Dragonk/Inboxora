# MailFlow Conversation Engine v2 — fixed quality-gate decisions

## Branch
`feat/threading-v2-integration-live`

## Required final stack
The final stack must use the exact branch names and order required by the completion/finalization documents:

1. `feat/threading-v2-r3-01-correctness`
2. `feat/threading-v2-r3-02-conversation-model`
3. `feat/threading-v2-r3-03-ingest-rebuild`
4. `feat/threading-v2-r3-04-provider-automated-series`
5. `feat/threading-v2-r3-05-api-settings`
6. `feat/threading-v2-r3-06-outlook-list`
7. `feat/threading-v2-r3-07-gmail-reader`
8. `feat/threading-v2-r3-08-hardening`
9. `integration/threading-v2-r3-pl-beta`

## Constraints
- Do not mutate historical `backend/migrations/0002_subject_threading.sql`.
- Do not merge into `main` or `upstream`.
- Do not open upstream PRs.
- Do not use production data or production mailboxes.
- Every branch needs its own `PRn_DESCRIPTION.md` and must be a direct descendant of the previous branch.
- Validate ancestry, patch-id, diff scope, and `git diff --check` before reporting.

## Quality gates required before stack creation
- Fresh schema.
- Real legacy upgrade fixture with data, including old subject-only `Test` joins.
- Partial rebuild/resume.
- Full write followed by full second rebuild with zero mutations and identical checksums.
- Concurrent rebuild/live sync behavior.
- Tenant-scoped composite constraints with negative cross-user tests.
- Override precedence and complete merge/split reconciliation.
- Gmail, Outlook, and generic/Fastmail provider fixtures.
- Strict and smart automated-series fixtures.
- Security route/ownership tests.
- Real performance EXPLAIN assertions.
- Real browser E2E matrix.
- EN/FR/PL locale validation and screenshots.
- Independent adversarial review after all changes.

## Current truth
The last exact-SHA green workflow was run `32029016100`, but later changes invalidate it. A new run is required after the final integration commit.
