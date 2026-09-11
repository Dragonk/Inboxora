# Contacts and DAV

Inboxora keeps contacts in first-party address books **and** publishes them over CardDAV, so the
same contacts appear in DAVx5, Thunderbird, iOS and Android. Calendars work the same way over
CalDAV.

![Contact details](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contacts-desktop.png)

## Address books

- Create, rename, recolour, hide or delete local address books. At least one local book remains.
- Address books appear as scrollable tabs above the search field. **All visible** respects the
  visibility filter, and a hidden book can still be selected explicitly.
- Switching books keeps your current search; results from a previous book can never replace the
  ones you are looking at.
- Contacts discovered automatically from received mail are marked **auto**.
- Read-only books (CardDAV imports) cannot be edited locally.

The book menu holds book creation, visibility, **Google CSV import** into local books, and
**Google CSV / Outlook CSV / vCard export**.

## Contact fields

Contacts support the standard vCard fields:

| Group | Fields |
| --- | --- |
| Names | Display name, first name, last name, nickname |
| Work | Organisation, job title, role |
| Contact | Multiple typed emails and phones, websites, instant messages |
| Addresses | Structured addresses with type, PO box, street, second line, city, region, postal code, country |
| Dates | Birthday, anniversary, name day and custom labelled dates |
| Other | Categories, notes, photo |

- The first email is the primary one used for avatars and autocomplete.
- Dates are stored as `YYYY-MM-DD`, and dates without a year are stored as `--MM-DD` and repeat
  every year.
- Birthday and anniversary dates appear automatically in the read-only **Contact dates**
  calendar described in [Calendar](Calendar.md).
- If a rich field is empty, Inboxora falls back to the stored vCard, so fields written by a DAV
  client appear without re-importing.

## Import and export

| Direction | Format | Notes |
| --- | --- | --- |
| Import | Google CSV | Into a local book; re-importing updates matching contacts instead of duplicating them. |
| Export | Google CSV | Per address book. |
| Export | Outlook CSV | Per address book. |
| Export | vCard 3.0 | Per address book. |

Exported CSV values that would start a spreadsheet formula are prefixed so they cannot execute.

## Searching

Search matches the display name, primary email, organisation, and every stored email address and
phone number. Results are paginated as you scroll, and contacts you email often are ordered
first. Hidden books are excluded unless you select them.

## Working with a contact

On wide screens the list and the contact details sit side by side; on tablets and phones
selecting a contact opens its details with an in-app Back action.

- Selecting an email address opens the composer with that recipient already filled in.
- **Edit** opens the full editor with all rich fields, including multiple emails, phones,
  addresses and dates.
- Contacts in a read-only CardDAV book cannot be edited or deleted locally.

| Contacts on a phone | Editor on a phone |
| --- | --- |
| ![Contacts on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contacts-mobile.png) | ![Contact editor on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/contact-editor-mobile.png) |

## DAV endpoints

| Protocol | Endpoint | Discovery |
| --- | --- | --- |
| CardDAV | `/carddav` | `/.well-known/carddav` |
| CalDAV | `/caldav` | `/.well-known/caldav` |

Both use HTTP Basic authentication and support discovery, queries, multi-get, incremental sync
with sync tokens, and conditional updates. Conflict handling is real: a write with a stale
version tag is rejected rather than overwriting somebody else's change, and a client that
presents an unknown sync token is told to resynchronise from scratch.

Events that Inboxora owns because invitations were sent for them are protected from being
silently modified by a DAV client.

## Application passwords

**DAV clients never use your Inboxora login password.** Inboxora primary-login credentials are
not DAV credentials; DAV clients must use a revocable application password. This is what makes
CardDAV and CalDAV work on accounts protected by TOTP or SSO.

Create one under **Settings → DAV access**:

1. Give the credential a name you will recognise later (for example *Pixel 7 · DAVx5*).
2. Choose **Create password**.
3. **Copy the password immediately** — it is displayed exactly once and only its hash is stored.
4. Use it with your normal Inboxora **username** in the DAV client.

The list shows when each password was created and last used. **Revoke** disables one device
without affecting the others, your login, or any other application password.

![DAV access settings](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/settings-dav-access-desktop.png)

### DAVx5 on Android

1. Install DAVx5 and choose **Add account → Login with URL and user name**.
2. **Base URL** — your Inboxora URL, for example `https://mail.example.com`.
3. **User name** — your Inboxora username.
4. **Password** — the application password you just created.
5. DAVx5 discovers both CardDAV and CalDAV automatically; select the address books and calendars
   you want on the device.

### iOS, Thunderbird and others

Use the same values, or the explicit endpoints:

```
https://your-domain/.well-known/carddav
https://your-domain/.well-known/caldav
```

## Pulling contacts from another CardDAV server

Inboxora can also act as a **client**: connect a remote CardDAV server (for example Nextcloud)
under **Settings → Integrations**. The remote credentials are verified before saving and
encrypted at rest, address books are discovered automatically, and they appear locally as
read-only books.

Duplicate handling is configurable — keep separate entries, merge them, or skip imported
duplicates. Disconnecting removes the locally synced read-only books and contacts; the remote
data is untouched.

Public remote servers must use HTTPS. Cleartext HTTP is accepted only for private or local hosts,
and only when the administrator allows private connections.
