# Security

Inboxora stores mail credentials and gives access to your correspondence, contacts and
calendars. Treat it like a password manager with a web front end.

## Network boundary

- Keep Inboxora **behind the reverse proxy** that terminates TLS. Do not publish additional host
  ports for browser access.
- Set `APP_URL` to the external HTTPS URL so cookies, invitation links and OAuth callbacks are
  correct.
- Forward `X-Forwarded-Proto: https` from the proxy; without it, session cookies are rejected or
  downgraded.
- The bundled Caddy profile is only for deployments where Inboxora itself owns ports 80/443.

## Secrets

| Secret | Meaning if it leaks | Meaning if it is lost |
| --- | --- | --- |
| `SESSION_SECRET` | Sessions can be forged | Everyone is signed out |
| `DB_PASSWORD` | Database access | Inboxora cannot start |
| `ENCRYPTION_KEY` | Stored mail and DAV credentials can be decrypted | Stored credentials are permanently unreadable |
| VAPID private key | Push notifications can be spoofed | Push stops working; regenerate |

Keep `.env` out of source control, restrict its permissions, and back it up **with** the
database — an `ENCRYPTION_KEY` restored without its database, or the reverse, is useless.

Never paste deployment secrets, app passwords, OAuth client secrets or password-reset links into
issues, screenshots, logs or this Wiki.

## Accounts and authentication

- Passwords are stored as hashes; two-factor authentication uses TOTP with QR enrolment and an
  email fallback through the system mail account.
- Administrators can enforce MFA instance-wide and set how long a trusted device stays trusted.
- Login protection limits repeated attempts within a time window, and a login-activity log
  records access.
- SSO is available through OIDC providers; password login can be disabled once a provider is
  enabled and the administrator has linked an identity of their own.

## DAV credentials

- CardDAV and CalDAV clients authenticate with **dedicated application passwords**, never the
  primary login password. Primary credentials are explicitly rejected on DAV endpoints, which is
  what allows TOTP and SSO accounts to sync to phones.
- Application passwords are stored only as hashes and can be revoked individually.
- DAV endpoints are rate-limited per IP, and authentication failures are logged.

## Mail and calendar connections

- The administrator controls which servers Inboxora may reach: private and local addresses,
  insecure TLS and non-standard ports are each gated under **Settings → Security**.
- External calendar and DAV sources are validated against the same policy, which limits
  server-side request forgery. Public sources must use HTTPS, and URLs containing credentials
  are refused.
- Credentials for external CalDAV and remote CardDAV sources are encrypted at rest and never
  returned by the API.
- Calendar invitation delivery requires selecting an enabled SMTP account that you own.

## Rendering untrusted content

- Message HTML is rendered without scripts in a sandboxed frame with a restrictive content
  policy, and is sanitised both when stored and when displayed.
- **Remote images are blocked by default**, including tracking pixels; the allow-list is explicit
  per address or domain.
- Links are limited to `https:` and `mailto:` and open in a new tab.
- Contact labels, calendar descriptions and event text from external sources are escaped rather
  than executed.

## Data at rest and in transit

- The database and Redis are not exposed publicly; keep them on the internal Docker network.
- Everything between the user and Inboxora is TLS, terminated at your proxy.
- Credentials for mail accounts, DAV application passwords, external calendar sources and the
  system mail account are encrypted with `ENCRYPTION_KEY` before they are stored.

## Operations

- Back up the database and `.env` before every upgrade.
- Run a **diagnostics report** when asking for help: it contains versions, environment, counts
  and error categories, and it excludes addresses, names, message content and secrets, hashing
  identifiers instead.
- Keep the instance updated; releases contain security fixes, and the About panel shows the
  running version and build.

## Reporting a vulnerability

Please do not open a public issue with exploit details. Open a minimal issue asking for a
private channel, or contact the maintainer through GitHub.
