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
  public host ports for Inboxora.
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
- WebSocket upgrade for `/api` so live updates and push work

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
