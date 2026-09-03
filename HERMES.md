# Inboxora — Hermes execution contract

## Scope

- Canonical repository: `https://github.com/Dragonk/Inboxora.git`.
- Canonical integration branch: `dev`.
- Do not work in legacy MailFlow checkouts or any release branch.
- Treat `dev` as the only integration target. Do not push or open a PR unless Kamil explicitly asks.

## Kanban automation

- The orchestrator may automatically decompose a well-scoped Triage card and dispatch independent children when their task bodies contain this project contract or explicitly cite this file.
- Every implementation child must use an isolated Git worktree created from the current `origin/dev`, on its own `wt/<task-id>` branch. Never let concurrent workers write to the canonical checkout.
- Before the first edit and before commit, verify: canonical remote, worktree path, branch descended from current `origin/dev`, and no unrelated changes.
- A completed, independently verifiable slice must run targeted tests, receive a diff review, and be committed immediately with `Assisted-by: Hermes Agent`.
- Integration into `dev` belongs to the orchestrator: rebase/cherry-pick against current `dev`, run integration tests and review, then report readiness. Do not push automatically.
- Use dependencies only for real data/API/order constraints. Independent implementation, test, and review tasks should run in parallel within configured concurrency limits.

## Routing and quality

- Luna: simple, localized and low-risk changes.
- Terra: medium-complexity or cross-component changes.
- Sol: high-risk, security-sensitive, performance-critical, or architectural work.
- Every child card must state: current failure/reproduction, expected result, acceptance criteria, tests (and relevant viewport/API cases), non-goals, and commit boundary.
- Developers implement and test. Reviewers independently inspect committed work and request precise changes. The orchestrator owns routing, dependencies, integration and release gates.

## Safety

- Never expose credentials, tokens, secrets, connection strings or real user data.
- Browser QA must use a fresh preview and report observed facts; do not claim visual verification without it.
