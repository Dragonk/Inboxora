# Inboxora 4.4.6

Released **2026-11-26**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.6) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.6/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-446)

## Container and dependency security patch

**There are no functional changes to the Inboxora application itself in 4.4.6.** This is
strictly a security patch release rebuilding the Docker images and updating locked
dependencies to address container and Python package advisories reported since 4.4.5.

## Security

- **Frontend Docker image (`nginx:alpine`).** `frontend/Dockerfile` now runs
  `apk upgrade --no-cache` before installing `openssl`, ensuring base Alpine packages
  are updated at build time:
  - `CVE-2026-111497` (Critical): `brotli-libs` updated from `1.2.0-r1` to `>= 1.2.1-r0`.
  - `CVE-2026-125350` (High): `libxslt` updated from `1.1.43-r3` to `>= 1.1.43-r4`.
- **Backend Docker image (`node:22-alpine` and preview Python environment).**
  - `GHSA-6q48-6c7w-9gw2` (Critical): `certifi` in `backend/preview/requirements.txt`
    upgraded from `2026.7.22` to `2026.11.20` (`>= 2026.10.18`).
  - `backend/Dockerfile` now runs `apk upgrade --no-cache` before installing runtime
    packages so base Alpine libraries (`libcrypto3`, `libssl3`, `zlib`, etc.) are
    updated at build time.

## Known safe limitations

- Application features, database schema, API routes, environment variables and native
  client behavior are identical to 4.4.5. No database migration or configuration change is
  required when upgrading from 4.4.5.

## Validation

- Local Docker builds for both `frontend/Dockerfile` and `backend/Dockerfile` succeeded
  with upgraded Alpine packages (`brotli-libs-1.2.1-r0`, `libxslt-1.1.43-r4`) and
  `certifi==2026.11.20`.
- Backend preview Python tests (`python3 -m unittest discover -s backend/preview -p 'test_*.py' -v`),
  backend and frontend builds/typechecks/lint/unit tests, and `scripts/release-source.test.mjs`
  verified.
