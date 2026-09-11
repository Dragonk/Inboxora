# Troubleshooting

Start with the **diagnostics report** (Settings → About): it lists versions, environment,
per-account and folder counts, sync error categories and server health, with identifiers hashed
and no message content. It is the fastest way to describe a problem in an issue.

## Sign-in and browser problems

| Symptom | Likely cause |
| --- | --- |
| Signed out on every request, or login appears to succeed then bounces | `APP_URL` does not match the browser URL, or the proxy is not forwarding `X-Forwarded-Proto: https`. |
| Invitation or password-reset links do not work | `APP_URL` is wrong, or **System email** is not configured so no mail was sent. |
| Two-factor codes rejected | Device clock drift; TOTP depends on accurate time on both sides. |
| Password login disabled | SSO is enabled and password login was turned off. Use the SSO button. |
| Changes lost after an update | A service worker from an older build is still cached; reload the page once. |

## Mail does not arrive

1. Check the account state in the sidebar: a connection error is shown per account.
2. **Settings → Accounts** → sync the folders manually and read the error.
3. Verify the IMAP host, port and TLS mode. If the provider requires an app password
   (Gmail, Yahoo, iCloud), a normal account password will fail authentication.
4. For Microsoft 365, confirm the Azure application is configured and the account was
   reconnected after the credentials changed.
5. If several accounts share one mail server and sync stops intermittently, the server may be
   limiting connections. Set `IMAP_MAX_PERSISTENT_PER_HOST` to the server's limit.
6. Enable/disable the account to force a full reconnect.

Unread counts that look wrong usually follow a failed sync — sync the folder and they correct
themselves.

## Sending fails

| Message | Meaning |
| --- | --- |
| *Sent, but not saved to your Sent folder* | The message was delivered. Only the Sent copy failed; do not resend. |
| Idempotency or duplicate-send error | A previous attempt is still in flight. Wait a moment and retry. |
| SMTP authentication error | Wrong SMTP password, or the provider requires an app password. |
| Attachment too large | The combined uploaded, inline and forwarded size exceeds the limit. |
| Sending unavailable | Redis is not reachable. Idempotent sending requires it. |

## Threading looks wrong

- Open the message's **threading diagnostics** to see why it was grouped as it was.
- Same message in two of your accounts is deliberately two conversations; your account is the
  identity boundary.
- Use the conversation actions to **split**, **merge**, **move** a message or **lock** a
  conversation so future messages stay where you put them.
- If a whole account looks misgrouped, ask an administrator to run a **dry-run rebuild** first
  and review the result before applying it.

## Calendar problems

| Symptom | Check |
| --- | --- |
| An event cannot be edited | It comes from an imported read-only calendar or from a CardDAV/CardDAV-synced source. |
| Invitation not delivered | Choose an enabled SMTP account in the event dialog and use **Retry save**. |
| A month looks incomplete | A recurrence could not be fully expanded; the view says which series is incomplete. |
| An external source shows an error | Open **Manage sources**: the source status lists the last error category. Verify the URL and use a dedicated CalDAV app password. Other calendars keep working. |
| An ICS link stopped working | The secret feed may have been rotated or revoked; create a new link. |

## Contacts and DAV

- Import a Google CSV into a **local** book; read-only books reject edits.
- If a field is missing after a DAV sync, check the contact's stored vCard — Inboxora falls back
  to it, so a re-import is usually unnecessary.
- DAV client will not connect:
  - Use an **application password** from Settings → DAV access, not your login password.
  - Use your Inboxora **username**, not your email address.
  - Confirm `https://your-domain/.well-known/carddav` and `/.well-known/caldav` resolve from the
    device; some networks block discovery redirects.
  - A client that was offline for a long time is told to resynchronise — accept the full resync.
- Conflicts: a client writing a stale version is rejected instead of overwriting newer data.
  Resync the client and repeat the change.

## Mobile layout

- Confirm the navigation position (**top** or **bottom**) in Appearance settings.
- Reload once after an update so the new service worker takes over.
- If Back behaves unexpectedly, remember that Back first closes in-app layers: reader, contact
  details, forms, sheets and the drawer, before leaving the app.

## Performance on large mailboxes

- Prefer paginated scrolling over infinite scrolling.
- Turn off message previews and quick actions if the list feels heavy.
- Narrow the sync window by leaving accounts out of the unified inbox if you do not need them
  there; this also reduces unified search scope.

## Getting help

Open an issue with:

1. The diagnostics report (it is already redacted).
2. The exact steps you took and what you expected.
3. Screenshots **without** credentials, addresses or message content you would not share
   publicly.

Never place credentials in issue reports, screenshots or logs.
