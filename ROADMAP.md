# Inboxora Roadmap

It follows a **Now / Next / Later** format — no dates, no commitments. Priorities shift as the
community's needs become clear.

## Shipped in 4.0.0

- Dedicated, revocable DAV application passwords, so CardDAV and CalDAV sync through DAVx5 works
  for password, TOTP and OIDC accounts.
- Contacts and Calendar as first-class destinations in the left sidebar.
- Read-only external CalDAV and iCalendar sources.
- The conversation engine: real email threading with manual overrides, diagnostics and rebuilds.

## Now

- Stabilising the native shells: Electron desktop and Android/Capacitor, including signing and
  the deferred security review before either can be published.
- Documentation and onboarding polish for self-hosters (release notes, upgrade guidance,
  screenshots).

## Next

- Authoring recurrence rules (`RRULE`) from the event editor instead of reading them only.
- Richer calendar sharing: per-user feed links with revocable scopes.
- Faster rebuilds and threading diagnostics for very large mailboxes.

## Later

- Backup and restore tooling for a whole instance.
- Scheduled send and an undo-send delay in the composer.
- Optional automatic spam classification.
- iOS shell, if there is demand for one.

## Not planned

Things Inboxora deliberately does not do, so that expectations are clear:

- No analytics, telemetry or advertising. The only outbound calls the server makes on its own are
  the optional release check and the opt-in avatar/favicon lookups described in
  [Security](docs/wiki/Security.md).
- No mandatory cloud dependency. Third-party services (AI provider, Todoist, remote CardDAV) are
  optional and off until an administrator enables them.

Have a feature idea? [Open an issue](https://github.com/Dragonk/Inboxora/issues).
