# Contributing to Inboxora

Thanks for helping improve Inboxora. Contributions are licensed under the project's
[AGPL-3.0-only licence](LICENSE).

## Before you start

- Search the [Inboxora issue tracker](https://github.com/Dragonk/Inboxora/issues).
- Discuss larger features, dependencies, refactors, or changes to core behaviour in an issue
  before implementation.
- Use a focused branch and keep one concern per pull request.

## Workflow

1. Fork the repository and branch from `dev` (the integration branch).
2. Add or update automated tests for behaviour changes.
3. Run the relevant checks locally:

   ```bash
   cd frontend && npm ci && npm test && npm run lint && npm run build
   cd ../backend && npm ci && npm test && npm run lint
   ```

4. Open a pull request against `dev` and describe the user-visible impact, validation, and any
   migration notes. Release and hotfix pull requests target `main`.

## Documentation

User-visible behaviour, configuration and troubleshooting live in the Wiki, whose reviewed
source is [`docs/wiki/`](docs/wiki/). Update the relevant page in the same pull request as the
code change, and keep links relative (`[Calendar](Calendar.md)`). Release-level changes are
recorded in [`docs/CHANGELOG.md`](docs/CHANGELOG.md). See the
[Development](docs/wiki/Development.md) page for the full policy.

## Commit messages

Use concise Conventional Commit-style subjects, for example `fix: handle calendar ETag conflicts`
or `feat: add DAV device credentials`.

## Code style

- Match surrounding code and keep changes small.
- Backend uses Node.js/Express with async/await.
- Frontend uses React hooks and the established inline-style/CSS-variable patterns.
- Do not add dependencies without an issue explaining why the existing stack is insufficient.
- Keep documented API, DAV and storage contracts stable; the deliberately retained legacy
  identifiers are listed in [`docs/technical-identifier-audit.md`](docs/technical-identifier-audit.md).

## Reporting bugs and requesting features

Use [Issues](https://github.com/Dragonk/Inboxora/issues) with clear reproduction steps, expected
behaviour, actual behaviour, and safe screenshots or logs where useful. Include the built-in
diagnostics report where you can — it is already redacted. Never include credentials, tokens or
personal data. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public
issue.
