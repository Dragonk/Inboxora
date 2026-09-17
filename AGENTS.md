# Inboxora — agent instructions

## Scope and Git workflow

- Canonical repository: `https://github.com/Dragonk/Inboxora.git`; canonical integration branch: `dev`. Work only in this checkout and target `dev` unless the user explicitly says otherwise.
- Before editing and immediately before committing, verify the remote, branch, working tree, diff scope and that `origin/dev` has not advanced. Never commit review archives, extracted findings, temporary package-manager files, build output, secrets or unrelated changes.
- Keep changes focused and add regression tests for every corrected defect. Run `git diff --check` before each commit.
- Every code-producing agent must add a commit trailer naming itself: `Assisted-by: <agent name>`. Use the actual agent name or stable task-agent name, never invent a human attribution.
- Before committing, independently re-check the final diff and rerun the relevant quality gates. Do not commit if tests, type checking, linting, migration checks or build checks relevant to the change fail.

## Code quality and safety

- Fix causes, not symptoms. Do not silence failures with `@ts-ignore`, `@ts-nocheck`, blanket `any`/`as any`, ESLint disables, weakened assertions, skipped tests or swallowed errors. A narrowly justified runtime guard or type narrowing is preferred.
- Preserve security and privacy boundaries: authentication/session generations, authorization, recipient privacy (especially BCC), idempotency, durable delivery state and database transaction/lease ownership. Treat ambiguous external side effects as uncertain; never automatically retry them as definitely safe.
- Add migrations additively. Never rewrite migrations that may already have been applied. Document required migration order and upgrade implications in release notes.
- Keep frontend async effects scoped to the session and component/operation that started them. Late requests, timers and callbacks must not mutate a later session.
- Keep backend side effects durable and recoverable. Claims, checkpoints and completion state must be ownership-checked and safe across restarts.

## Testing and verification

- Run focused regression tests while implementing, then applicable backend/frontend typecheck and lint. Run a production build when frontend build inputs change. Use `TMPDIR=/tmp` if the harness cache path is unavailable.
- Validate migrations with the migration-integrity suite; for behavior involving PostgreSQL, Redis, SMTP, restarts or leases, add the strongest practical integration/recovery coverage.
- Treat expected error-path logs in passing tests as evidence only when the assertions prove the intended behavior. Investigate every non-zero command exit before proceeding.
- Before publishing, fetch `origin/dev`, verify there is no divergence, inspect the staged diff, commit, push, and confirm a clean `dev...origin/dev` status.

## Changelog, release notes and documentation

- Update `docs/CHANGELOG.md` and the matching `docs/wiki/Release-notes-<version>.md` automatically with every user-visible, reliability, security, migration or operational change. Keep these files as the only release documentation unless the user asks for another document.
- Changelog entries must be concise, factual and grouped by release. Release notes must explain user/operator impact, known safe limitations, validation and migration/configuration requirements.
- When a new migration is added, name it, state its required order, and explain whether it must be applied before application rollout.
- Do not change a release version merely by inference: use the requested/current release version, or ask when a new version is needed.

## Collaboration

- Split independent implementation, testing and review work when safe, but avoid concurrent edits to the same files. Review changed production behavior before integration.
- Report only verified facts: changed files, commit SHA, pushed branch, commands and their results, deployment steps, and remaining limitations.
