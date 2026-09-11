# Installation

Inboxora ships as two container images — `ghcr.io/dragonk/inboxora-backend` and
`ghcr.io/dragonk/inboxora-frontend` — plus PostgreSQL and Redis. Docker Compose is the
supported deployment method.

Use a **tagged release** image for a stable deployment. The mutable `:dev` images are build
candidates for testing only and must not be used for a server people depend on.

## Prerequisites

- A host with Docker Engine and the Docker Compose plugin.
- Persistent storage for PostgreSQL and Redis.
- An existing reverse proxy for browser access and TLS termination. Do not expose additional
  public host ports for Inboxora. The proxy must pass WebSocket upgrades for `/ws` (live
  updates) and for `/push` (Android instant notifications).
- A hostname and TLS certificate. `APP_URL` must be the external HTTPS URL whenever you use
  invitations, OAuth callbacks or browser cookies.
- Outbound network access to your mail and calendar providers. For Microsoft 365, the host must
  be able to reach `login.microsoftonline.com`.

## Start a deployment

1. Create a directory and download the deployment files from the release you are installing:

   ```bash
   mkdir inboxora && cd inboxora
   curl -O https://raw.githubusercontent.com/Dragonk/Inboxora/main/docker-compose.ghcr.yml
   mv docker-compose.ghcr.yml docker-compose.yml
   curl -O https://raw.githubusercontent.com/Dragonk/Inboxora/main/.env.example
   cp .env.example .env
   ```

2. Set a pinned `INBOXORA_VERSION` in `.env` (for example `4.0.0`) instead of relying on a
   mutable tag.

3. Generate unique secrets and write them into `.env`:

   ```bash
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 16   # DB_PASSWORD
   openssl rand -hex 32   # ENCRYPTION_KEY
   ```

   Keep `.env` outside source control. **Changing or losing `ENCRYPTION_KEY` makes every stored
   mail and DAV credential unreadable** — users then have to re-enter passwords and re-consent
   OAuth accounts.

4. Set `APP_URL` to the external HTTPS URL and configure the reverse proxy to forward HTTPS
   requests with the appropriate forwarded-proto header (`X-Forwarded-Proto: https`), otherwise
   session cookies are rejected.

5. Start the stack and check health before directing users to it:

   ```bash
   docker compose up -d
   docker compose ps
   curl -fsS "$APP_URL/api/health"
   ```

The stack includes **ntfy**, the built-in UnifiedPush transport for Android instant
notifications. It is published by the same frontend on the same domain — no second hostname and
no second certificate:

```text
Inboxora:      ${APP_URL}
UnifiedPush:   ${APP_URL}/push
```

Android users install the **ntfy** app and point it at `${APP_URL}/push`; see
[Notifications and background delivery](Notifications.md). No additional configuration is
required for the default setup. To use your own external ntfy instead, set `PUSH_BASE_URL` and
start with `docker-compose.external-ntfy.yml` (download it alongside the compose file).

The first account you register becomes an administrator; additional users join through
invitations or open registration, depending on your settings.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_URL` | Yes in production | Public URL used in invitation links, OAuth callbacks and cookies. |
| `SESSION_SECRET` | Yes | Signs session cookies. |
| `DB_PASSWORD` | Yes | Password for the bundled PostgreSQL. |
| `ENCRYPTION_KEY` | Yes | Encrypts stored mail and DAV credentials at rest. |
| `INBOXORA_VERSION` | Recommended | Pins the image tag. |
| `APP_PORT` / `APP_HTTP_PORT` | No | Published ports for the frontend container (default 443/80). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | No | Enables Web Push. Generate once with `npx web-push generate-vapid-keys`. |
| `PUSH_BASE_URL` | No | Advanced: an external ntfy base URL. Defaults to `${APP_URL}/push`. |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | No | Allow a private/LAN (http) UnifiedPush endpoint. Off by default (SSRF guard). |
| `NTFY_CACHE_DURATION` | No | How long the bundled ntfy keeps an undelivered event (default `12h`). |
| `NTFY_DATA` | No | Host path for the bundled ntfy data (a Docker named volume by default). |
| `FCM_SERVICE_ACCOUNT_JSON` | No | Optional/experimental FCM transport for custom Android builds. Not required. |
| `DOMAIN` / `ACME_EMAIL` | No | Only for the bundled Caddy profile that terminates TLS itself. |
| `IMAP_MAX_PERSISTENT_PER_HOST` | No | Caps always-on IMAP connections per host when one mail server limits them. |
| `POSTGRES_DATA` / `REDIS_DATA` / `PUID` / `PGID` | No | Bind mounts and ownership for Unraid-style deployments. |
| `UPDATE_CHECK_DISABLED` | No | Disables the server-side GitHub release check. |

`VITE_EMAIL_DIV_RENDER` is an experimental renderer switch; leave it unset.

## Optional HTTPS with Caddy

The supplied Caddy profile is an alternative **only** when Inboxora itself owns public ports
80/443. Do not enable it behind an existing reverse proxy.

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d
```

It requires `DOMAIN`, `ACME_EMAIL` and `APP_URL`, and ports 80/443 open to the internet.

## Behind an existing reverse proxy

Point the proxy at the frontend container's HTTP port and forward the original scheme:

- `X-Forwarded-Proto: https`
- `X-Forwarded-For` and `Host` as usual
- WebSocket upgrade for `/ws` and `/push`, plus a long idle timeout for `/push` so the
  UnifiedPush connection is not dropped

Leave the Caddy profile off in this setup.

## Mail, DAV and push setup

All three are configured inside the application after startup:

- **Mail accounts** — Settings → Accounts. Gmail uses an app password; Microsoft 365 uses
  OAuth and needs an administrator to register an Azure application under Settings →
  Integrations.
- **DAV access** — Settings → DAV access. Generate an application password per device for
  CardDAV/CalDAV. See [Contacts and DAV](Contacts-and-DAV.md).
- **Web Push** — Settings → Notifications, once the VAPID key pair is present in the
  environment.
- **Android instant notifications** — install the **ntfy** app on the phone and set its server
  to `${APP_URL}/push`. Inboxora detects the app and registers automatically; the status
  appears under Settings → Notifications. See
  [Notifications and background delivery](Notifications.md). No Firebase project is involved.

Never paste deployment secrets, app passwords or OAuth credentials into issue reports, Wiki
pages or source control.

## Upgrades and backups

Back up the PostgreSQL volume and `.env` before every upgrade. Then update the pinned image
version, pull and recreate:

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on backend start. Review the release notes and
[Upgrading](Upgrading.md) before a major version change.

Replacing an existing **MailFlow** deployment — rather than installing fresh — is a different
procedure with its own traps around database and volume names: see
[Migrating from MailFlow](Migrating-from-MailFlow.md). Only MailFlow 3.3.0 is supported as a
migration source.
