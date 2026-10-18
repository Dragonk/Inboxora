# Inboxora 4.3.5

Released **2026-10-18**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.5) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.5/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-435)

Inboxora 4.3.5 is a patch release fixing four regressions reported on 4.3.4: missing
notifications and unread badges for Microsoft Graph and Gmail accounts, a Microsoft
message stuck unread after it was deleted on the server, the Android top bar rendering
below the status bar, and attachment downloads doing nothing in the Android app.

## Fixed

- **Notifications for Microsoft Graph and Gmail accounts.** The canonical new-mail event
  was built only by the IMAP sync, so accounts connected through Microsoft Graph or the
  Gmail API never produced a Web Push notification, an unread badge or a native Android
  push, even with notifications enabled in settings. Both syncs now emit the same event
  for incremental INBOX deltas — a full baseline never notifies, and mail silenced by a
  mark-read ingest rule is filtered out.
- **Ghost messages stuck unread.** When Microsoft Graph answers 404 on a message that
  was deleted on the server, the message row used to stay in the list forever: it could
  not be opened, could not be marked read and kept the unread badge stuck. The flag
  worker and the body reader now enqueue the same tombstone the folder sync uses, so the
  existing durable reconciliation verifies the deletion and removes the row shortly
  after the next sync.
- **Android top bar below the status bar.** 4.3.3 introduced a second insets mechanism on
  top of Capacitor's native system-bar handling, pushing the top bar below the status
  bar with a visible gap. The manual padding and the theme fitsSystemWindows handling
  are removed; the app renders edge-to-edge exactly like the PWA, with the CSS safe-area
  variables positioning the top bar.
- **Attachment downloads in the Android app.** An <a download> click is silently
  ignored inside the Android WebView, so the download button did nothing. Attachments the
  server can serve (single files and the zip) are now handed to the system DownloadManager
  with the session cookie and the CSRF header, and blobs the app already holds (archive
  entries, exports) stream back in bounded base64 chunks and are saved through MediaStore.
  Files land in Downloads/Inboxora.

## Known limitations

- **PWA badge on Android Chrome.** Chrome on Android does not implement the Badging API,
  so an app icon count is not available to any installed PWA. Android draws a dot on the
  icon automatically when a notification is visible, which the notification fix above now
  produces for Microsoft Graph and Gmail accounts too.
- **Blob downloads on Android below 10** are saved to the app's external files directory
  (Android/data/io.github.dragonk.inboxora/files/Download/Inboxora), because writing to
  the public Downloads collection needs a legacy storage permission this app does not
  request. URL downloads always land in the public Downloads/Inboxora.

## Upgrade requirements

Back up PostgreSQL and .env as usual, then deploy matching 4.3.5 backend and frontend
images. There is no database migration and no new configuration key.

Use one of the immutable stable image tags:

- ghcr.io/dragonk/inboxora-backend:4.3.5
- ghcr.io/dragonk/inboxora-frontend:4.3.5

v4.3.5 and latest point to the same multi-architecture AMD64/ARM64 manifests after
release publication. Android 4.3.5 uses versionCode 4030500. Windows, Linux and Android
artifacts are attached to the GitHub release after the signed native build completes.
