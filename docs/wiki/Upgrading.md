# Upgrading

Inboxora runs its database migrations automatically when the backend starts. An upgrade is
therefore: back up, change the version, pull, recreate.

> **Always back up PostgreSQL and `.env` first.** `ENCRYPTION_KEY` is not stored in the database;
> restoring a database backup without the matching key leaves every stored credential
> unreadable.

Coming from MailFlow rather than an earlier Inboxora? Use
[**Migrating from MailFlow**](Migrating-from-MailFlow.md) instead.

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
- If you run a fork with local modifications, review [`docs/CHANGELOG.md`](https://github.com/Dragonk/Inboxora/blob/dev/docs/CHANGELOG.md) for the
  full change list.

### What to expect

| Area | After the upgrade |
| --- | --- |
| Existing preferences | Kept. Theme, fonts, layout, panel widths and notification settings are not reset. |
| Mail | Unchanged accounts and folders. Threading becomes available and is **off by default**; enable the threaded list and/or conversation reader in Settings → Appearance. |
| Conversation metadata | Populated as mail syncs. Historical mail is grouped gradually; an administrator can run a rebuild per account. |
| Calendar | New local calendars start empty. Add CalDAV or ICS sources to import existing ones. |
| Contacts | New empty address books. Import a Google CSV, or connect a CardDAV account to pull existing contacts. |
| DAV | CardDAV and CalDAV endpoints become available. Existing devices need an **application password** from Settings → DAV access. |
| Bookmarks | Unchanged. The phone layout and navigation drawer are the same shell as 3.4. |

### Recommended post-upgrade steps

1. Sign in and confirm folders and unread counts.
2. Open **Settings → Appearance** and decide whether to enable the threaded list and the
   conversation reader.
3. Add contacts (import or CardDAV) and calendars (local, CalDAV or ICS).
4. Create DAV application passwords for each device and re-add the account on the device.
5. Ask an administrator to review **Threading diagnostics** if a mailbox is grouped oddly, and
   to run a dry-run rebuild first.

## Rollback

Images are pinned, so a rollback is an image change:

1. Set `INBOXORA_VERSION` back to the previous version.
2. `docker compose pull && docker compose up -d`.
3. If the newer version applied migrations your older image does not understand, restore the
   database backup taken before the upgrade.

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
[`docs/technical-identifier-audit.md`](https://github.com/Dragonk/Inboxora/blob/dev/docs/technical-identifier-audit.md).

## Versioning

Inboxora uses semantic versioning. Major versions signal new product areas or breaking
configuration changes, minor versions add features, and patch versions fix defects. Every release
is documented in [`docs/CHANGELOG.md`](https://github.com/Dragonk/Inboxora/blob/dev/docs/CHANGELOG.md) and on the
[releases page](https://github.com/Dragonk/Inboxora/releases).
