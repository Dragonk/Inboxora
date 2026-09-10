# Mobile navigation

- The calendar uses a floating action button for a new event; desktop keeps the action in the calendar sidebar.
- Mobile Back closes an in-app detail/form before browser history can leave the PWA.
- Select **top** or **bottom** calendar toolbar placement in Appearance settings. The bottom position observes device safe areas; calendar FABs shift above it to remain tappable.
- The calendar panel opens on demand on mobile to preserve screen space.

The V3 shell keeps Mail, Calendar and Contacts in the navigation drawer opened from the common top bar. The saved top/bottom setting controls the calendar toolbar position. Calendar sources and the selected day's agenda open in drawers with keyboard focus containment and in-app Back support.

Up to 1100 layout pixels, contacts and side-by-side mail layouts use separate list/detail panels. A saved vertical mail layout remains vertical. Font scaling is included when deciding whether a compact presentation is needed; saved widths and layout preferences are retained.
