# Development changes - unreleased

Wide fixed-layout emails (hard-coded 600-700 px newsletters, fixed-width table cells) previously left a horizontal scrollbar inside the message on phone-sized screens. Every message view (reading pane, conversation reader, calendar descriptions, HTML attachment previews) now first lets the body reflow and then scales whatever still overflows down to the frame width — the same fit-to-width behaviour Gmail uses. Pinch zoom and text selection keep working, the scale is recomputed as images load and when the pane resizes, and document-layout previews (e.g. docx) intentionally keep their natural width with their own scrolling.

For the current stable release, see [Release notes 4.3.8](Release-notes-4.3.8.md). Older
versions are listed in [Archive](Archive.md).
