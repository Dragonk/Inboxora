# V3 interface

The visual reference is the supplied `V3-Inboxora.html`. The implementation uses its panel proportions, Ink colors, typography, borders and controls with real application data. Demo content and simplified message grouping from the mockup are not application behavior.

| Area | Implemented presentation | Existing capabilities retained |
| --- | --- | --- |
| Shell | 250px default navigation, thin resize dividers, shared controls and typography | Saved widths, layouts, themes, fonts, scaling, settings, plugins and compose modes |
| Calendar | 242px sidebar, full-height calendar, 296px day agenda, compact drawers and month Agenda view | Month/week/work-week, working hours/days, week start, visibility, local event editing/deletion, invitations and retry, ICS/CalDAV source management, calendar ownership controls |
| Contacts | Address-book tabs and actions menu, shared search, readable detail/form panes | All rich fields, multiple addresses, dates, categories, photos, read-only contacts, import/export, pagination, deletion and email composition |
| Compact screens | Single list/detail panel for contacts and horizontal mail layouts up to 1100 layout pixels | Vertical mail layout, contextual Back, keyboard navigation, safe areas and saved calendar toolbar placement |

Calendar month queries cover the complete 42-day grid, including adjacent months. Both agendas follow source visibility. Month Agenda groups events by occupied day with an exclusive end date, placing all-day events before timed events. Selecting a day does not refetch an unchanged range. Imported event details open without editable controls. The week grid preserves its scroll position during navigation and re-anchors on view/work-hour changes.

On phones, month event chips open event details; the day agenda provides readable full titles. Week/work-week retain explicit event action buttons. Shared dialogs support Escape, in-app Back, contained keyboard focus and return focus to the trigger. Portal dialogs respect interface scaling without inheriting pane clipping.

## Regression checks

- `calendarAgenda.test.js`: complete date ranges, month transitions and multi-day ordering.
- `v3-interface.spec.js`: agendas, visibility, imported details, rich-contact round trips, composer recipients, failed-save retry, scale and preferences, panel geometry, and visual references.
- Existing browser suites: native thread grouping/reader combinations, mutations and rollback, calendar source management, time-grid geometry, mobile navigation and keyboard focus. Selectors follow the common top bar and drawer.
- `real-app.spec.js`: real login/conversation rendering, rich contact edits and calendar creation/reload/deletion with PostgreSQL and Redis. Test-owned contacts and events are cleaned up.

Visual references cover mail, compose, settings, login, calendar month/week/agenda, contact details and forms at 1440×900, 1024×768, 390×844, 412×915 and 915×412. Screenshot updates require visual review; CI only compares committed references. Tests use synthetic data and self-hosted fonts, with fixed date/time and locale for visual cases.

No database migration or API schema change is needed for this interface update. Existing preferences are retained rather than reset to the reference defaults.
