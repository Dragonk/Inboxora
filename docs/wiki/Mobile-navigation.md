# Mobile navigation

The same application adapts from a phone to a wide desktop. This page describes what changes and
how to get around on a small screen.

![Inboxora on a phone](https://raw.githubusercontent.com/Dragonk/Inboxora/main/media/screenshots/mail-list-mobile.png)

## Layout breakpoints

| Width | Behaviour |
| --- | --- |
| Below 767 px | Phone shell: one panel at a time, a top bar and a navigation drawer. |
| 767 – 1100 px | Compact layout: list and detail are still separate panels for Mail, Contacts and Calendar. |
| Above 1100 px | Full desktop layout with side-by-side panels. |

A saved vertical mail layout stays vertical, and saved panel widths are kept. Font scaling is
taken into account when deciding whether a compact presentation is needed.

## The top bar and the drawer

- The top bar shows the current module's own header and actions.
- The drawer — opened from the top bar — switches between **Mail**, **Calendar** and
  **Contacts**, and gives access to accounts, settings and sign-out.
- Swiping left on the drawer closes it.
- The bar can sit at the **top** or the **bottom** of the screen (**Settings → Appearance**). The
  bottom position respects device safe areas, and floating action buttons shift above it so they
  stay tappable.

## Creating things

On phones the primary create action is a **floating action button**: compose a message, create a
calendar event, or add a contact. On desktop the same actions live in the sidebar or the panel
header.

## Back behaviour

Mobile Back closes an in-app layer before it can leave the app:

- reader → contact details → contact form → calendar dialogs → the drawer → the admin panel,
  in the order they were opened.
- A form that is busy saving does not get dismissed by Back.
- At the mailbox root, normal browser or system Back is preserved, so you can still navigate
  away from the app.
- On Android the hardware Back button is wired to the same handler and only backgrounds the app
  when nothing in the app wants the event.

## Dialogs and sheets

- Calendar sources and the selected day's agenda open in drawers and sheets with keyboard focus
  containment and in-app Back support.
- Event dialogs become full screen on phones and respect safe-area insets.
- Touch targets grow on phones (44 px buttons, 40 px contact rows) and set columns stack.

## Installable app and notifications

- Inboxora is an installable PWA with an unread badge and push notifications; the service worker
  is push-only and does not cache the interface for offline use.
- On iOS, add Inboxora to the Home Screen before enabling push — the settings page says so when
  push is unavailable.
- Native shells for desktop (Electron) and Android (Capacitor) exist and are being stabilised;
  they are not part of the supported release yet.
