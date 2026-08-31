<p align="center">
  <img src="media/inboxora-logo.png" width="200" alt="Inboxora logo">
</p>

<p align="center">
  <strong>Inboxora</strong> — a self-hosted, unified inbox for email, contacts and calendars.
</p>

> **Special thanks to [maathimself](https://github.com/maathimself), creator of [MailFlow](https://github.com/maathimself/mailflow).**
> Inboxora began as a fork of MailFlow because it follows different functional and product-design goals. It keeps the required upstream notices and is developed independently under AGPL-3.0-only.

<p align="center">
  <a href="#installation">Quick Start</a> ·
  <a href="#email-provider-setup">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="https://github.com/Dragonk/Inboxora/issues">Issues</a>
</p>

## Licensing

- **[AGPL-3.0-only](LICENSE)** — Inboxora is free software. If you convey a modified copy or make a modified version available for users to interact with over a network, the AGPL requires an offer of the corresponding source code.

The project does not offer a commercial licence. AGPL permits commercial use and sale; it protects users' right to receive the corresponding source for modified network services. Required copyright notices and upstream attribution remain intact.

Contributions are accepted under the same AGPL-3.0-only terms; see [CONTRIBUTING.md](CONTRIBUTING.md).


## Features

- **Unified inbox** — all accounts merged in one view, sorted by date
- **Sender imagery** — real manual/CardDAV contact photos take priority, with optional domain favicons proxied and cached through Twenty Icons and deterministic initials as the offline fallback; disable sender favicons under Appearance to prevent lookups for your user
- **Email categorization** — automatic inbox tabs (Primary, Newsletters, Social, Notifications, Other) sort incoming mail by type using header detection and sender heuristics; AI reclassify button for misclassifications
- **Unsubscribe** — one-click unsubscribe button appears in the message pane for detected newsletters; sends the request or opens the unsubscribe URL automatically
- **Conversation threads** — messages grouped into reply chains with inline sent replies
- **Optional conversation controls** — list grouping and Conversation Reader V2 can each be enabled or disabled independently in Settings → Appearance → Layout
- **Rich text compose** — WYSIWYG editor with font family, size, color, highlight, tables, emoji, links, attachments, image resize handles, and Excel table paste
- **Attachments** — send and receive file attachments across all accounts
- **Multiple layouts** — classic, compact, wide reader, vertical split, and more
- **Multiple themes** — dark, light, and several color schemes; custom CSS field for per-user style overrides
- **Multi-language UI** — English, French, Spanish, Italian, German, Russian, Simplified Chinese, and Polish
- **Full-text search** — across all connected accounts simultaneously
- **Real-time notifications** — WebSocket-powered new-mail toasts and web push notifications
- **PWA** — installable as a desktop or mobile app with push notification support
- **Command palette** — Cmd+K / Ctrl+K quick-access for actions and navigation
- **Keyboard shortcuts** — full shortcut set, fully customisable per user
- **Smart contact autocomplete** — learns from sent mail to rank suggestions
- **Reply / Forward / Compose** — correct per-account SMTP routing; font family groups, email priority
- **Folder navigation** — expand any account to browse folders
- **Folder-structure sync** — folders created or renamed in other clients appear automatically, on a configurable interval or on demand
- **Star, archive, delete, mark read/unread** — synced back to IMAP
- **Mark-as-read behavior** — choose immediate (on open), after a configurable delay in seconds, or manual (button only) per-user preference
- **Inbox rules** — automate actions (move, archive, delete, mark read, star) based on sender, subject, recipient, headers, body, or attachments
- **Block list** — automatically move mail from blocked senders to trash before inbox rules run
- **Spam reporting** — mark messages as spam or not spam from the context menu, toolbar, or bulk actions; feedback will feed into automated filtering in a future release
- **Snooze** — snooze messages until a chosen time; they reappear at the top of the inbox
- **AI assistant** — use an OpenAI-compatible API provider or a ChatGPT Codex subscription; summarise threads, draft replies, ask questions about a message
- **Password recovery** — recover your account via a recovery email address configured in profile settings
- **User management** — admin panel, invite-only registration, invite emails
- **Two-factor authentication** — TOTP (any authenticator app), email OTP fallback, persistent device trust; admin-configurable enforcement policy
- **SSO / OIDC** — single sign-on via any OpenID Connect provider; group claims from the IdP can be mapped to the Inboxora admin role, with optional RP-initiated (end-session) logout to sign out of the provider too
- **Microsoft 365 / OAuth2** — work accounts via Azure App Registration; personal Outlook.com via device code flow
- **Todoist integration** — create tasks directly from emails; tasks include a deep link back to the original message
- **CardDAV contacts** — expose contacts to phone and desktop contact apps; contact photos sync and appear as sender avatars in the message list
- **DAV Hub (in progress)** — revocable DAV application passwords plus first-party contacts and calendar resources for DAVx5-compatible CardDAV/CalDAV sync
- **GTD workflow** — optional Getting-Things-Done rail: label threads Todo / Watch / Delegated / Someday / Reference (each backed by a real IMAP folder) with the t / w / d keys; opt in per account, see below

---

## GTD (Getting Things Done)

An optional Getting-Things-Done workflow, off by default and enabled per account
under Settings → Categories → GTD. When on, a rail beside the message list
groups threads into five states, each backed by a real IMAP folder — so the labels
are just server-side folders that sync to every mail client and survive Inboxora
itself:

- **Todo** / **Someday** — things you need to act on; the label clears itself once you reply.
- **Watch** / **Delegated** — things you're waiting on; the label clears itself once the other party replies.
- **Reference** — kept until you remove it by hand.

Label the selected thread from the keyboard — **t** for Todo, **w** for Watch,
**d** for Delegated (all remappable in the keyboard-shortcut settings) — or from the
context menu, which also covers Someday and Reference. Each state's folder name is
configurable per account, and accounts with GTD off behave exactly as before.

---

## Screenshots

Screenshots are intentionally omitted until clean Inboxora captures of the Contacts and Calendar interface are ready.

---

## Installation

There are three ways to run Inboxora. The pre-built image method is recommended for most users.

---

## Option A — Pre-built images (recommended)

No cloning or building required. Docker pulls the pre-built images directly from GHCR.

### Prerequisites

- A server with Docker and Docker Compose installed

### 1. Download the compose file and default config

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/Dragonk/Inboxora/main/docker-compose.ghcr.yml
curl -o .env               https://raw.githubusercontent.com/Dragonk/Inboxora/main/.env.example
```

### 2. Configure environment

Edit `.env` — the required fields are:

| Variable | Description |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 3. Start

```bash
docker compose up -d
```

Inboxora will be available on port 443 (HTTPS, self-signed certificate) and port 80 (HTTP).

**Ports are configurable in `.env`:**

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` | `443` | HTTPS port |
| `APP_HTTP_PORT` | `80` | HTTP port |

**Optional — automatic HTTPS via Let's Encrypt:** set `DOMAIN` and `ACME_EMAIL` in `.env`, download the HTTPS overlay, then restart:

```bash
curl -o docker-compose.https.yml https://raw.githubusercontent.com/Dragonk/Inboxora/main/docker-compose.https.yml
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d
```

This adds a Caddy reverse proxy that handles certificate issuance and renewal automatically. Requires Docker Compose 2.21+, a public domain with DNS pointing at the server, and ports 80/443 open.

**Optional — behind your own reverse proxy:** point your proxy at port 80. Set `APP_HTTP_PORT` in `.env` if you need a different host port. Your proxy should forward `X-Forwarded-Proto: https` so that session cookies are marked Secure correctly.

### 4. Create your admin account

Open `https://your-domain.com` in a browser. The **first account registered becomes
the admin**. After registering, you can close registration and manage users from the
settings panel → Users tab.

### 5. Add your email accounts

In the settings panel → Accounts → Add Account.
Select a preset (Gmail, iCloud) or Custom for any IMAP server.

### Updating

```bash
docker compose pull
docker compose up -d
```

To pin to a specific version instead of `latest`, add `INBOXORA_VERSION=3.4.0` to your `.env`.

---

## Option B — Build from source

### Prerequisites

- A server with Docker and Docker Compose installed

### 1. Get the code

```bash
git clone https://github.com/Dragonk/Inboxora.git inboxora
cd inboxora
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the required fields are:

| Variable | Description |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 3. Build and start

```bash
docker compose up -d --build
```

First build takes 2–3 minutes. Inboxora will be available on port 443 (HTTPS, self-signed certificate) and port 80 (HTTP).

**Optional — automatic HTTPS via Let's Encrypt:** set `DOMAIN` and `ACME_EMAIL` in `.env`, then start with the HTTPS overlay (requires Docker Compose 2.21+):

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile https up -d --build
```

**Optional — behind your own reverse proxy:** point your proxy at port 80. Your proxy should forward `X-Forwarded-Proto: https` so that session cookies are marked Secure correctly.

### 4. Create your admin account

Open `https://your-domain.com` in a browser. The **first account registered becomes
the admin**. After registering, you can close registration and manage users from the
settings panel → Users tab.

### 5. Add your email accounts

In the settings panel → Accounts → Add Account.
Select a preset (Gmail, iCloud) or Custom for any IMAP server.

---

## Option C — Native install (no Docker)

Run Inboxora directly on any Linux, macOS, or BSD machine using Node.js, PostgreSQL, and Redis.
No container runtime required. The steps below use Ubuntu/Debian; adapt package manager commands for other platforms.

### Prerequisites

- **Node.js 22 (LTS)** — [nodejs.org](https://nodejs.org) or via your package manager. Newer majors break the backend: Node's built-in `fetch` conflicts with the pinned `undici` dispatcher.
- **PostgreSQL 16+**
- **Redis 7+**
- **nginx** — serves the built frontend and proxies API/WebSocket requests to the backend

### 1. Install system dependencies

**Ubuntu / Debian:**
```bash
# Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql redis-server nginx
```

**macOS (Homebrew):**
```bash
brew install node@22 postgresql@16 redis nginx
brew services start postgresql@16
brew services start redis
```

### 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER inboxora WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE inboxora OWNER inboxora;
SQL
```

### 3. Get the code

```bash
git clone https://github.com/Dragonk/Inboxora.git /opt/inboxora
cd /opt/inboxora
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. In addition to the required secrets, set these for a native install:

| Variable | Value |
|---|---|
| `APP_URL` | Full URL, e.g. `https://mail.example.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` — override for a Postgres server on a non-standard port |
| `DB_NAME` | `inboxora` |
| `DB_USER` | `inboxora` |
| `DB_PASSWORD` | password you set in step 2 |
| `REDIS_URL` | `redis://localhost:6379` — or `redis+unix:///path/to/redis.sock` for a Unix socket |

For Docker installs, the bundled Postgres/Redis work out of the box. To point at **external** database or cache servers (any host/port), or to store data on a host **bind mount** (e.g. an Unraid appdata share with `PUID`/`PGID`), see the "Database & Redis" and "Storage & permissions" sections of [`.env.example`](.env.example).
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

### 5. Build the frontend

```bash
cd /opt/inboxora/frontend
npm ci
npm run build
# Built files are written to /opt/inboxora/frontend/dist
```

### 6. Install backend dependencies

```bash
cd /opt/inboxora/backend
npm ci --omit=dev
```

### 7. Configure nginx

A ready-to-use nginx config is provided in `contrib/nginx.conf`. Copy it, update the `root` path, then enable it:

```bash
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp /opt/inboxora/contrib/nginx.conf /etc/nginx/sites-available/inboxora
```

Open `/etc/nginx/sites-available/inboxora` and replace `/path/to/inboxora/frontend/dist` with `/opt/inboxora/frontend/dist`.

The provided config listens on port 80 for use behind a TLS-terminating reverse proxy (Nginx/Caddy/Traefik). If you want nginx to terminate TLS directly, uncomment the HTTPS server block in the file and set your certificate paths. A quick self-signed cert:

```bash
sudo mkdir -p /etc/ssl/inboxora
sudo openssl req -x509 -nodes -newkey rsa:4096 -days 3650 \
  -keyout /etc/ssl/inboxora/key.pem \
  -out    /etc/ssl/inboxora/cert.pem \
  -subj "/CN=inboxora"
```

Enable the site and reload nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/inboxora /etc/nginx/sites-enabled/inboxora
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Run the backend

**Option A — systemd (recommended for production):**

```bash
sudo cp /opt/inboxora/contrib/inboxora.service /etc/systemd/system/inboxora.service
# Edit the service file if your install path or user differs from the defaults
sudo systemctl daemon-reload
sudo systemctl enable --now inboxora
sudo systemctl status inboxora
```

**Option B — PM2:**

```bash
sudo npm install -g pm2
cd /opt/inboxora/backend
pm2 start src/index.js --name inboxora
pm2 save
pm2 startup   # follow the printed command to register auto-start on boot
```

**Option C — foreground (testing only):**

```bash
cd /opt/inboxora/backend
node src/index.js
```

### 9. Create your admin account

Open the app in a browser. The **first account registered becomes the admin**. After registering, close open registration from Settings → Users.

### 10. Add your email accounts

In the settings panel → Accounts → Add Account.

### Updating

```bash
cd /opt/inboxora
git pull
cd frontend && npm ci && npm run build && cd ..
cd backend && npm ci --omit=dev && cd ..
sudo systemctl restart inboxora   # or: pm2 restart inboxora
```

---

## Email Provider Setup

### Gmail

Gmail requires an **App Password** (not your normal password):

1. Enable 2-step verification on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Create a new App Password — name it "Inboxora"
4. Use the 16-character password in the Inboxora account form

| Setting | Value |
|---|---|
| IMAP Host | `imap.gmail.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.gmail.com` |
| SMTP Port | `587` |
| Username | your Gmail address |

### iCloud / Apple Mail

1. Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords
2. Generate a password — name it "Inboxora"

| Setting | Value |
|---|---|
| IMAP Host | `imap.mail.me.com` |
| IMAP Port | `993` |
| SMTP Host | `smtp.mail.me.com` |
| SMTP Port | `587` |
| Username | your full iCloud email (`you@icloud.com`) |

### Microsoft 365 / Outlook (OAuth2)

Microsoft has disabled basic (password) auth for Outlook.com, Hotmail, and most
Microsoft 365 accounts, so they connect via OAuth2 under **Settings → Integrations →
Microsoft 365** (not the normal Add Account form). This is a one-time setup: you
create a free [Microsoft Entra app registration](https://portal.azure.com) once, and
the same app then serves every account and user on your instance.

**1. Register the app.** In the Azure portal, go to **Microsoft Entra ID → App
registrations → New registration**. Under **Supported account types**, choose
**"Accounts in any organizational directory and personal Microsoft accounts"** so it
covers both Outlook.com/Hotmail and work/school accounts. After creating it, copy the
**Application (Client) ID**.

**2. Grant the mail permissions.** Open the app's **API permissions** page and add
both of these, then follow the consent note:

- **Add a permission → APIs my organization uses → Office 365 Exchange Online →
  Delegated permissions**, and add **`IMAP.AccessAsUser.All`** and **`SMTP.Send`**
  (if Exchange Online is not listed, type "Exchange" in the search box).
- **Add a permission → Microsoft Graph → Delegated permissions**, and add
  **`offline_access`**, **`openid`**, **`email`**, and **`profile`**.
- For **work / school** accounts, click **Grant admin consent for your
  organization**. Personal accounts consent at sign-in and can skip this.

> This step is required. Without these permissions the account still "connects" and
> is added, but no mail loads and sending fails with a credentials error, because
> Outlook's IMAP and SMTP servers reject a token that lacks the mail scopes.

Then follow the steps for your account type:

**Personal accounts (Outlook.com / Hotmail)** (public client, device code):

1. In the Azure app, open **Authentication** and set **"Allow public client flows"**
   to **Yes**. No client secret or redirect URI is needed.
2. In Integrations → Microsoft 365, enter the **Client ID** and **Tenant ID**
   (`common`), leave Client Secret and Redirect URI blank, then save.
3. Start the device-code flow shown there. Inboxora displays a short code; visit
   [microsoft.com/devicelogin](https://microsoft.com/devicelogin) and enter it to
   authorise.

**Work / school accounts (Microsoft 365)** (confidential client):

1. In the Azure app, open **Authentication → Add a platform → Web**, and set the
   redirect URI to `https://<your-inboxora-host>/oauth/microsoft/callback` (the exact
   value is shown on the Integrations screen).
2. Under **Certificates & secrets → New client secret**, create a secret and copy its
   **Value** (not the Secret ID).
3. In Integrations → Microsoft 365, enter the Client ID, Tenant ID, Client Secret,
   and Redirect URI, then save and click **Connect Microsoft account**.

### Custom IMAP

Any standard IMAP/SMTP server works. Use port 993 for IMAP (TLS) and
587 (STARTTLS) or 465 (TLS) for SMTP.

---

## Management

```bash
# View all logs
docker compose logs -f

# View backend logs only
docker compose logs -f backend

# Stop
docker compose down

# Stop and delete all data (destructive)
docker compose down -v

# Update to latest images (pre-built install)
docker compose pull && docker compose up -d

# Rebuild after a code change (Docker build-from-source install)
docker compose up -d --build

# Update a native install
git pull && \
  cd frontend && npm ci && npm run build && cd .. && \
  cd backend && npm ci --omit=dev && cd .. && \
  sudo systemctl restart inboxora   # or: pm2 restart inboxora
```

## Backup and Restore

```bash
# Backup database
docker exec inboxora-postgres pg_dump -U inboxora inboxora \
  > inboxora-$(date +%Y%m%d).sql

# Restore database
cat inboxora-YYYYMMDD.sql | \
  docker exec -i inboxora-postgres psql -U inboxora -d inboxora
```

---

## Architecture

### Default deployment (self-signed HTTPS)

```
Browser (HTTPS / HTTP)
  │
  ▼
nginx  (frontend container — ports 443 + 80)
  │
  ├── /api/*  → Node.js backend (port 3000)
  ├── /oauth/ → Node.js backend (port 3000)
  └── /ws     → Node.js backend WebSocket (port 3000)
                    │
                    ├── PostgreSQL  (messages, accounts, users)
                    ├── Redis       (sessions)
                    └── IMAP        (outbound to mail servers)
```

nginx and the backend communicate on an internal Docker network. PostgreSQL and Redis are not exposed outside that network.

### With your own reverse proxy

```
Browser (HTTPS)
  │
  ▼
Your proxy  (Nginx / Traefik / Caddy / etc. — TLS termination)
  │  X-Forwarded-Proto: https
  ▼
nginx  (frontend container — port 80)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

### With automatic HTTPS (--profile https)

```
Browser (HTTPS)
  │
  ▼
Caddy  (ports 80/443 — TLS termination, auto Let's Encrypt)
  │
  ▼
nginx  (frontend container — internal only)
  │
  └── backend, PostgreSQL, Redis (internal network, unchanged)
```

## Desktop and Android apps

Inboxora remains a self-hosted web app, but the repository includes native wrappers for users who prefer an installed desktop or mobile application:

- Windows, macOS, and Linux use Electron-based packages.
- Android uses a Capacitor WebView wrapper.
- On first launch, the native wrapper prompts for the Inboxora server URL, such as `https://mail.your-domain.com`, stores it locally, and connects to that server.
- Native package sources live under `frontend/packages`.

> **Note:** Prebuilt, signed native apps are not published yet — they are in development and will be attached to a future Inboxora release. For now you can build them locally from source:

```bash
cd frontend
npm ci
npm run electron:dist   # desktop installers (.exe / .dmg / .deb / .rpm)
npm run android:dist    # Android package (.apk / .aab)
```

## Upgrading

### GTD

GTD is opt-in per account (**Settings → Categories → GTD**). Migrations for the new schema are additive and apply automatically on first startup. No operator action needed.

### v2.5.0 – v2.7.0

No manual migration steps required. All schema changes apply automatically on first startup.

### v2.2.0 – v2.4.1

No manual migration steps required. All schema changes apply automatically on first startup.

### v2.1.0

No manual migration steps required. All schema changes apply automatically on first startup.

### v2.0.0

No manual migration steps required. All schema changes apply automatically on first startup.

`ENCRYPTION_KEY` is now required at startup. The server will refuse to start if the variable is missing or not exactly 64 hex characters. Generate one with `openssl rand -hex 32` before upgrading if you have not already set this.

### v1.9.0

Two database migrations (`0019_user_integrations`, `0020_mfa_device_trust`) run automatically on startup. No manual steps required.

2FA is off by default. Existing users are unaffected unless an admin enables enforcement under **Settings → Security**.

### Mail Server Connection Policy (earlier releases)

**Breaking change for accounts with "Skip TLS verification" enabled.**

An earlier release introduced an admin-controlled connection policy (Settings → Security → Mail Server Connection Policy). TLS verification is now enforced by default at the server level.

If any accounts were configured with **Skip TLS verification** (e.g. for a self-signed certificate on a local IMAP server), those accounts will stop syncing after upgrading from an older version. To restore connectivity, an admin must enable **Allow insecure TLS** in Settings → Security before or immediately after deploying.

---

## Security notes

- The first registered user becomes the admin automatically
- Close open registration in Settings → Users once you've set up your accounts
- Use the invite system to onboard additional users
- Enable two-factor authentication in Settings → Security — supports TOTP (authenticator app), email OTP fallback, and persistent device trust. TOTP codes are one-time and cannot be replayed within their validity window
- Session cookies are `HttpOnly`, `SameSite=Lax`, with a 7-day TTL. The `Secure` flag is set automatically when the connection is HTTPS (direct or via a proxy that forwards `X-Forwarded-Proto: https`)
- Passwords are bcrypt-hashed (cost factor 12)
- Login and registration endpoints are rate-limited (10 attempts per 15 minutes per IP)
- Password reset tokens are consumed atomically — concurrent reset requests cannot both succeed
- Database and Redis are not exposed outside the Docker network
- IMAP/SMTP credentials are stored at rest in the database (standard for webmail clients — protect access to your server and database volume accordingly)
- Responses set a strict `Content-Security-Policy`, clickjacking protection via `X-Frame-Options`, and a restrictive `Referrer-Policy`
- Email HTML is sanitized before rendering, including stripping external `url()` references from CSS style blocks to prevent tracking
