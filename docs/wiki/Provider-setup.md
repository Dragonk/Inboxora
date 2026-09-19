# Connecting Google and Microsoft accounts (API features)

Inboxora reads mail over IMAP/SMTP, so a mailbox works without any API registration. **Contacts and
calendars** from Google, and **contacts** from Microsoft, are read through the provider APIs
instead, and those need an application registered by an administrator once per installation.

This page is the procedure for that registration, with the exact fields, redirect URIs and scope
names the current code uses. Everything here is per **installation**, not per user; users then
connect their own accounts from **Settings → Integrations → Email providers**.

| Feature | Provider | What is read | What it needs |
| --- | --- | --- | --- |
| Google contacts | Google People API | Personal contacts | Google OAuth client |
| Google calendars | Google Calendar API | Calendars and events | Google OAuth client |
| Microsoft contacts | Microsoft Graph | Default Outlook contact folder | Entra application |
| Mailbox sign-in | Microsoft OAuth2 | IMAP/SMTP access token | Entra application |

Mail is **not** read through these APIs: Google mail continues over IMAP with an app password, and
Microsoft mailbox sign-in issues an IMAP/SMTP-scoped token that cannot be used against Microsoft
Graph. The two Microsoft connections are therefore separate grants — see
[Microsoft: two different connections](#microsoft-two-different-connections).

## Required environment values

| Variable | Used for |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google contacts and calendars |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI`, `MS_TENANT_ID` | Microsoft mailbox sign-in and Microsoft contacts |
| `PROVIDER_SYNC_INTERVAL_MINUTES` | How often pulled collections are refreshed (default 15, `0` disables) |

`MS_TENANT_ID` defaults to `common`, which accepts both work/school and personal accounts. Use the
tenant id (or `consumers`) when the application is registered as single-tenant. The value is
validated before it is placed in a URL, and an unusable value falls back to `common` rather than
being sent.

Set the variables in the same environment file the server reads at start-up (see
[Installation](Installation.md)), then restart the container. The readiness shown on the provider
cards is read from the environment, so a card that says the API is not configured means the
variable is missing from the running process, not that the values need re-saving.

## Google

### 1. Create the project and enable the APIs

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project.
2. Under **APIs & Services → Library**, enable **People API** for contacts and **Google Calendar
   API** for calendars. Enable only what you intend to use.

### 2. Configure the OAuth consent screen

1. Under **APIs & Services → OAuth consent screen**, choose **External** (or **Internal** for a
   Workspace-only installation) and fill in the application name and support e-mail.
2. Add every user who will connect an account as a **test user** while the app is in testing, or
   publish the app. Contacts and Calendar scopes are sensitive, so a published app may require
   Google's review; an unverified app in testing is limited to its test users.

### 3. Create the client

1. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application**.
2. Add the exact redirect URI (replace the host with your Inboxora address):

   ```
   https://mail.example.com/oauth/google/callback
   ```

   It must match `GOOGLE_REDIRECT_URI` character for character, including scheme, host, port and
   path. A mismatch fails at Google with `redirect_uri_mismatch` before Inboxora is reached.
3. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
   and set `GOOGLE_REDIRECT_URI` to the same URI. Restart the server.

### 4. Connect an account

1. As any signed-in user, open **Settings → Integrations → Email providers** and expand **Google**.
2. Choose **Connect a Google account**. Inboxora asks only for what the feature needs: contacts for
   the contacts connector, or the calendar scopes for calendars. Mail scopes are never requested by
   this button.
3. After consent, the card reports the connection and **Sync Google contacts** appears in the
   Contacts page's address-book menu (calendars appear in **Settings → Calendar → Manage sources**).

Pulled data arrives read-only and with **DAV access: Disabled**; see
[Contacts and DAV](Contacts-and-DAV.md) and [External calendars](External-calendars.md).

## Microsoft

### 1. Register the application

1. In the [Entra admin center](https://entra.microsoft.com/) open **Applications → App
   registrations → New registration**.
2. Choose the supported account types that match your users (single tenant, or multi-tenant and
   personal accounts).
3. Add **both** redirect URIs under **Web** if you want both the mailbox sign-in and the contact
   connector (replace the host with your Inboxora address):

   ```
   https://mail.example.com/oauth/microsoft/callback
   https://mail.example.com/oauth/provider/microsoft/callback
   ```

   The first belongs to the mailbox sign-in, the second to the API connector. Registering only one
   of them limits you to that feature. Inboxora derives the connector's URI from `APP_URL` (or takes
   `MS_PROVIDER_REDIRECT_URI` when you set it), so the two flows never share a callback.
4. Under **Certificates & secrets**, create a client secret and copy its **value** (not its id).
5. Under **Authentication**, enable **Allow public client flows** if you want the device-code
   method, which needs no secret and no redirect URI.
6. Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI` (the mailbox callback) and
   `MS_TENANT_ID`, then restart the server.

### 2. API permissions

Add the **delegated** Microsoft Graph permissions the features need, and grant admin consent if your
tenant requires it:

| Permission | Needed for |
| --- | --- |
| `User.Read` | Identifying the account that was just authorized (always requested) |
| `Contacts.ReadWrite` | Reading Outlook contacts (`Contacts.Read` when a read-only connection is requested) |
| `Calendars.ReadWrite` | Calendars, when that connector is used |

For the **mailbox sign-in** the application needs the IMAP/SMTP delegated permissions instead —
`IMAP.AccessAsUser.All` and `SMTP.Send` on the `outlook.office.com` resource. Those are the scopes
the sign-in flow actually requests; it does not request Microsoft Graph scopes.

### Microsoft: two different connections

Inboxora has two independent Microsoft authorizations, and confusing them is the most common
mistake:

| Action | Button | Authorization |
| --- | --- | --- |
| Mailbox sign-in | **Connect** on the Microsoft card | IMAP/SMTP scoped token, creates or updates the mail account |
| Contact connector | **Connect Microsoft contacts** on the same card | Microsoft Graph scoped grant, creates **no** account and changes no mailbox |

The Graph connector never touches the mailbox, and an account connected for mail does not by itself
grant contact access: each has its own grant, its own refresh token and its own re-authorization
state. Revoking one does not affect the other.

## How connections are kept alive

- Access tokens are refreshed automatically, single-flight: only one worker refreshes a grant at a
  time, and a stored token is only replaced by a newer generation. Microsoft rotates refresh tokens,
  so the returned one replaces the stored value.
- When a provider reports that consent was revoked or the client changed (`invalid_grant`), the
  grant is parked as needing re-authorization, and automatic refresh stops instead of retrying in a
  loop. The user reconnects the account from the same card.
- Pulled Google and Microsoft collections are refreshed on a schedule, but **only the collections a
  user already pulled**: connecting an account never starts an import by itself. Change the cadence
  with `PROVIDER_SYNC_INTERVAL_MINUTES`, or set it to `0` to refresh only when a user asks.

## Disconnecting an account

**Settings → Integrations** lists the accounts connected for each provider, with a **Disconnect**
button beside each one. Disconnecting:

- revokes the stored authorization and **deletes the saved access and refresh tokens**;
- stops the refresh schedule for that account and disables its imported collections, so nothing
  keeps syncing;
- **keeps your imported data.** Contacts, address books, calendars and events stay visible, and stay
  read-only.

Nothing imported is deleted, and that is deliberate: removing your data is a separate decision.
You cannot delete an imported collection while its source is still able to write to it, because the
next refresh would simply recreate it. To stop *seeing* it, hide it instead — the address book's
visibility toggle or the calendar's visibility switch — which never deletes anything.

Reconnecting the same account restores the connection and re-enables its collections. The next
refresh continues from where it stopped, and rebuilds from scratch if the provider rejects the old
position.

## Turning a provider or one of its methods off

An administrator can switch a whole provider off, and switch individual methods off, in
**Settings → Integrations**. Those switches are enforced, not cosmetic: a provider or method that is
switched off is no longer offered by the interface **and** no longer startable, so the card and the
flow always agree. The Microsoft **device-code** method has its own switch, because it needs only a
Client ID where the browser method needs a secret and the exact redirect URI.

## What Inboxora does not do with a connected account

Stated explicitly rather than left to be discovered, because a connector that silently ignores an
operation is worse than one that says it will not perform it.

**Both providers**

- **No write-back.** Contacts, address books, calendars and events pulled from a provider are
  read-only in Inboxora: editing or deleting them through the interface, through REST or through a
  DAV client is refused. Changes made at the provider appear here on the next refresh; changes made
  here are not sent there.
- **No push notifications.** Refreshes are scheduled (`PROVIDER_SYNC_INTERVAL_MINUTES`) or
  requested by hand. A change at the provider is not seen until then.
- **No new remote collections.** Inboxora discovers what exists; it does not create an address book
  or calendar at the provider.
- **No remote sharing or permissions management**, and no contact-group or label management beyond
  what the discovery returns.

**Google**

- Only the account's **personal** contacts are pulled (People API connections) — not the
  organization directory and not "Other contacts".
- **Google contact groups are not carried over.** A contact that belongs to several groups is stored
  once, as it should be, but its memberships are not represented locally — the connector does not read
  them. Group-based organisation therefore exists only in Google.
- **Photos and group memberships are not carried over.** The connector reads names, email addresses,
  phone numbers, organisation and job title, addresses, nicknames, notes, URLs, birthdays,
  anniversaries and instant-message handles. A photo needs its own authenticated request per contact,
  which is why it is not fetched, and group organisation exists only in Google.
- A Google calendar is imported as a whole; its events, not the calendar's own settings (colour,
  sharing, reminders), are represented.
- **Gmail is not connected at all**: mail for a Google account continues over IMAP/SMTP with an app
  password, and connecting Calendar or People does not change that and does not request Gmail
  permissions.

**Microsoft**

- **The mailbox is not connected over Graph**: mail continues over IMAP/SMTP from the accounts
  screen, and the connector covers contacts only. Microsoft calendars are not imported.
- The two authorizations are separate — the mailbox sign-in and the contacts connector have their
  own callbacks, their own readiness and their own switches.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The card says the API is not configured | The environment variable is missing from the running process. Set it and restart; readiness is read from the environment. |
| Google returns `redirect_uri_mismatch` | The registered URI and `GOOGLE_REDIRECT_URI` differ. They must match exactly, including scheme and host. |
| `AADSTS50011` after Microsoft consent | The redirect URI is not registered on the application, or the wrong one of the two Microsoft callbacks was added. |
| `AADSTS70008` / revoked consent | The grant was parked as needing re-authorization. Reconnect the account from the provider card. |
| A connector reports a missing scope (`403`) | The application is missing a delegated Graph permission, or admin consent was not granted. Add the permission and reconnect. |
| Contacts or calendars stop updating after a while | Microsoft Graph expires a delta token that has not been used for long enough; the next run rebuilds that collection from a baseline and reconciles it, so nothing is lost. |
| The mailbox works but contacts do not | The mailbox sign-in token is scoped to `outlook.office.com` and cannot read Graph. Use **Connect Microsoft contacts** as well. |

## Verification checklist

After configuring a provider, confirm all four:

1. The provider card shows the API as ready instead of asking for configuration.
2. **Connect …** completes and returns to Inboxora with a confirmation rather than an error.
3. The connector's sync action reports counts (added, updated, removed) rather than failing.
4. A second run shortly afterwards is incremental — it reports no new items — which shows the stored
   cursor is being reused rather than re-reading everything.
