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

A connected Google or Microsoft account is represented by a **grant**, and the credentials involved are three
separate things that must not be conflated: the **administrator's OAuth client** (a client id and, where the
method needs one, a secret), the **user's grant** (the access and refresh tokens issued to that account), and —
for mail that uses one — the **app password** held with the mail account. They live in different places, are
configured by different people, and removing one does not remove the others. Removing the API configuration
leaves Google IMAP accounts and their app passwords untouched, and disconnecting an account revokes the grant
and deletes its stored tokens without touching the mail account itself.

**Tokens are never handed to the browser.** An authorization happens in the user's browser, but the exchange
and the refresh happen on the server: the grant is written to the database and used from there, no endpoint
returns a token, and the device-code method polls server-side — the interface only ever shows a user code. For
the same reason, the sign-in method (SSO) is deliberately separate from the provider connections: an OIDC
identity provider signs a user in, a provider grant allows reading that user's contacts or calendars, and
neither implies the other.

Grant tokens are encrypted at rest with `ENCRYPTION_KEY`, like the rest of the stored credentials here. A
revoked or disconnected grant is marked as such and its tokens are **deleted**, not kept for a later retry.

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
