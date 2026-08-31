# Contributing to Inboxora

Thanks for helping improve Inboxora. Contributions are licensed under the project's [AGPL-3.0-only licence](LICENSE).

## Before you start

- Search the [Inboxora issue tracker](https://github.com/Dragonk/Inboxora/issues).
- Discuss larger features, dependencies, refactors, or changes to core behaviour in an issue before implementation.
- Use a focused branch and keep one concern per pull request.

## Workflow

1. Fork the repository and branch from `main`.
2. Add or update automated tests for behaviour changes.
3. Run the relevant backend and frontend checks locally.
4. Open a pull request against `main` and describe the user-visible impact, validation, and any migration notes.

## Commit messages

Use concise Conventional Commit-style subjects, for example `fix: handle calendar ETag conflicts` or `feat: add DAV device credentials`.

## Code style

- Match surrounding code and keep changes small.
- Backend uses Node.js/Express with async/await.
- Frontend uses React hooks and the established inline-style/CSS-variable patterns.
- Do not add dependencies without an issue explaining why the existing stack is insufficient.

## Reporting bugs and requesting features

Use [Issues](https://github.com/Dragonk/Inboxora/issues) with clear reproduction steps, expected behaviour, actual behaviour, and safe screenshots or logs where useful.
