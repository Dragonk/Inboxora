# Upgrading

Inboxora runs its database migrations automatically when the backend starts. An upgrade is
therefore: back up, change the version, pull, recreate.

> **Always back up PostgreSQL and `.env` first.** `ENCRYPTION_KEY` is not stored in the database;
> restoring a database backup without the matching key leaves every stored credential
> unreadable.

Coming from MailFlow rather than an earlier Inboxora? Use
[**Migrating from MailFlow**](Migrating-from-MailFlow.md) instead.

> **Upgrading 4.0.3 to 4.0.4 needs nothing beyond the standard steps.** 4.0.4 is a desktop-app
> release: no migration, no new environment variable, no API or configuration change, and the
> web/PWA and Android builds behave exactly as in 4.0.3. Only the Electron build gains the new
> title bar, notification settings and Windows default-app support. See
> [Release notes 4.0.4](Release-notes-4.0.4.md).

> **Upgrading 4.0.2 to 4.0.3 needs nothing beyond the standard steps.** 4.0.3 is a reliability
> release: database migrations `0094`–`0100` are applied automatically when the backend starts, no
> new environment variable is required, and antispam auto-move stays opt-in per account. See
> [Release notes 4.0.3](Release-notes-4.0.3.md).

> **Upgrading 4.0.0 to 4.0.1 needs nothing beyond the standard steps.** 4.0.1 is the TypeScript
> rewrite of the codebase: no schema migration, no new environment variable and no interface
> change. See [Release notes 4.0.1](Release-notes-4.0.1.md).

## Standard upgrade

```bash
# 1. Back up
docker compose exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" > inboxora-$(date +%F).sql
cp .env .env.backup

# 2. Update the pinned version in .env, then
docker compose pull
docker compose up -d

# 3. Verify
docker compose ps
curl -fsS "$APP_URL/api/health"
```

Watch the backend logs for migrations on the first start after an upgrade:

```bash
docker compose logs -f backend
```

## Upgrading to 4.0.0

4.0.0 is a major release: it adds calendars, contacts, DAV and the conversation engine. Most of
it is new surface rather than a change to existing behaviour, so an upgrade from 3.4.0 is
straightforward — but note the following.

### Before you upgrade

- Back up the database and `.env` as above.
- Note the current `INBOXORA_VERSION` so you can roll back the image if needed.
- If you run a fork with local modifications, review [`docs/CHANGELOG.md`](https://github.com/Dragonk/Inboxora/blob/main/docs/CHANGELOG.md) for the
  full change list.

### What to expect

| Area | After the upgrade |
| --- | --- |
| Existing preferences | Kept. Theme, fonts, layout, panel widths and notification settings are not reset. |
| Mail | Unchanged accounts and folders. Threading becomes available and is **off by default**; enable the threaded list and/or conversation reader in Settings → Appearance. |
| Conversation metadata | Populated as mail syncs. Historical mail is grouped gradually; an administrator can run a rebuild per account. |
| Calendar | New local calendars start empty. Add CalDAV or ICS sources to import existing ones. |
| Contacts | New empty address books. Import a Google CSV, or connect a CardDAV account to pull existing contacts. |
| Google accounts | **Nothing is removed and nothing is forced.** An existing mail account keeps working with its Google app password, and an administrator can *optionally* register a Google OAuth client to pull that account's contacts and calendars read-only. Connecting the API does not change the mail transport and does not ask for Gmail permissions. |
| Microsoft accounts | Mail needs the API connection, because Outlook.com and Microsoft 365 no longer accept a mailbox password. An administrator registers one Azure application — with either the browser or the device-code method — and each user then authorizes their own account. Existing accounts and their local history stay in place; they simply cannot reach the mailbox until that authorization happens. |
| Imported collections | Contacts and calendars pulled from a provider are **read-only** here: the provider is their writer. Editing, deleting or removing them through Inboxora is refused rather than silently undone at the next refresh. |
| DAV | CardDAV and CalDAV endpoints become available. Existing devices need an **application password** from Settings → DAV access. |
| Docker stack | A new **ntfy** service and a new `ntfy_data` volume are added for Android instant notifications. They are independent of PostgreSQL and Redis, so no mail, calendar or contact data is touched. Refresh the published `docker-compose.yml` from the release before pulling. |
| Notifications (Android) | Set the **ntfy** app's **Default server** to `https://<your-domain>` — the origin, **no `/push` path** (the ntfy app rejects a base URL with a path). Inboxora proxies the UnifiedPush topic namespace at that origin. PWA Web Push is unchanged. |
| Bookmarks | Unchanged. The phone layout and navigation drawer are the same shell as 3.4. |

### Recommended post-upgrade steps

0. Refresh the compose file from the release, then `docker compose pull && docker compose up -d`. The new
   `ntfy` service must be healthy (`docker compose ps ntfy`) before Android notifications work.
1. Sign in and confirm folders and unread counts.
2. Open **Settings → Appearance → Layout** and decide whether to enable the threaded list and the
   conversation reader.
3. Group the existing mail with **Rebuild conversations**, on the same screen. Start with the
   dry run (it is on by default) to see how much would change, then clear it and run again for
   real. Existing mail has no conversation until this runs; new mail is grouped as it syncs.
4. Add contacts (import or CardDAV) and calendars (local, CalDAV or ICS).
5. Create DAV application passwords for each device and re-add the account on the device.
6. If a mailbox is still grouped oddly afterwards, review **Threading diagnostics** for the
   affected conversations and use the manual merge, split or lock actions.

### If nothing is configured for a provider yet

The upgrade does not require a provider to be configured, and an installation may run with none. Mail over
IMAP/SMTP keeps working for every account that uses a password, including Google with an app password.

When an administrator does configure one:

1. register the application as [Connecting Google and Microsoft accounts](Provider-setup.md) describes;
2. save the client id (and secret, where the method needs one) on the provider card, and check that the card
   reports the method as ready;
3. each user authorizes their own account from the same card — the administrator's configuration and the
   user's authorization are deliberately separate, and no account is created or changed by configuring the
   application.

### About the provider notices

This release does **not** include the per-account migration prompt with an *Ignore* action and a
"do not show again" checkbox. What exists is the requirement itself, stated on the Microsoft card: mail for
those accounts needs the API connection. An administrator can switch a provider or one of its methods off,
which is enforced, and the whole provider layer can be switched off for an installation with
`PROVIDER_INTEGRATIONS_ENABLED=0`. The dismissal controls are part of the migration work and are not to be
expected here — worth knowing so that their absence is not read as a missing setting.

## Rollback

Images are pinned, so a rollback is an image change:

1. Set `INBOXORA_VERSION` back to the previous version.
2. `docker compose pull && docker compose up -d`.
3. If the newer version applied migrations your older image does not understand, restore the
   database backup taken before the upgrade.

Do **not** delete the `ntfy_data` volume when rolling back: it only holds undelivered push
events, and keeping it avoids re-registering devices. Do not revert database migrations by hand —
restore the pre-upgrade backup instead.

## Upgrading a MailFlow deployment

Inboxora began as a fork of [MailFlow](https://github.com/maathimself/mailflow), and an existing
MailFlow deployment can be moved over without losing data.

> **Only MailFlow 3.3.0 is supported as a migration source.** Newer MailFlow versions have not
> been tested and the migration history is not compatible with them.

[**Migrating from MailFlow**](Migrating-from-MailFlow.md) is the full procedure: what carries
over, the in-place and dump-and-restore routes, the database and volume naming traps that make a
migrated instance look empty, and how to group existing mail into conversations afterwards.

Two things to know before you start, both covered there in detail:

- Keep your existing **`ENCRYPTION_KEY`**, `DB_NAME` and `DB_USER`, and bring the stack up from
  the directory that holds your volumes. Inboxora's published compose file uses `inboxora` as its
  database default, and a new database name on an existing volume means the backend cannot
  connect.
- The image version variable was renamed: **`MAILFLOW_VERSION` → `INBOXORA_VERSION`**.

The retained legacy identifiers and the reasoning behind them are recorded in
[`docs/technical-identifier-audit.md`](https://github.com/Dragonk/Inboxora/blob/main/docs/technical-identifier-audit.md).

## Versioning

Inboxora uses semantic versioning. Major versions signal new product areas or breaking
configuration changes, minor versions add features, and patch versions fix defects. Every release
is documented in [`docs/CHANGELOG.md`](https://github.com/Dragonk/Inboxora/blob/main/docs/CHANGELOG.md) and on the
[releases page](https://github.com/Dragonk/Inboxora/releases).
