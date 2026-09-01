# Installation

Use a tagged release image for a stable deployment. The mutable `:dev` images are candidates for testing only.

## Prerequisites

- A host with Docker Engine and the Docker Compose plugin.
- Persistent storage for PostgreSQL and Redis.
- An existing reverse proxy for browser access and TLS termination. Do not expose additional public host ports for Inboxora.
- A public application URL when using invitations, OAuth callbacks or browser cookies.

## Start a deployment

1. Download `docker-compose.ghcr.yml` and `.env.example` from the selected release, then copy the example to `.env`.
2. Set a pinned `INBOXORA_VERSION` (for example, the selected release number) rather than relying on a mutable tag.
3. Generate unique values for `SESSION_SECRET`, `DB_PASSWORD` and `ENCRYPTION_KEY`; keep `.env` outside source control. Changing or losing `ENCRYPTION_KEY` makes previously stored encrypted credentials unreadable.
4. Set `APP_URL` to the external HTTPS URL and configure the reverse proxy to forward HTTPS requests with the appropriate forwarded-proto header.
5. Start the stack with `docker compose up -d`, then inspect service health before directing users to the application.

## Optional HTTPS and upgrades

The supplied Caddy profile is an alternative only when Inboxora itself owns public ports 80/443; do not enable it behind an existing reverse proxy. For upgrades, back up persistent data, update the pinned image version, run `docker compose pull`, then recreate the stack. Review release notes before upgrading.

## Mail and push setup

Add mail accounts from Inboxora settings after startup. Web Push is optional and requires a separately generated VAPID key pair. Never paste deployment secrets, app passwords or OAuth credentials into issue reports, Wiki pages or source control.
