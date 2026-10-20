# Development changes - unreleased

### Fixed

- **Pinch zoom in the message view on Android.** The Gmail-style shrink-to-fit introduced in 4.4.0 re-derived its scale on every layout pass. Pinch zooming the Android WebView reflows the layout - the frame's CSS-pixel width shrinks while fixed-width content keeps its size - so the pass ran mid-gesture and scaled the body right back down to the shrunk viewport: the zoom appeared to do nothing. The fit now keeps the recorded state while the viewport shrinks over unchanged content, so the zoomed message pans inside the frame (the same horizontal scrolling as before 4.4.0). Zooming out, rotating the device, widening the reading pane or any change of the content itself (image loads, quote folding) re-derives the fit as before.

Verified: unit contracts for the fit state machine (kept fit on a viewport shrink, re-derivation on viewport growth and content changes, first-format marker compatibility) plus Playwright regressions covering a synthesized pinch over a fitted email and a layout-viewport shrink reproducing the Android WebView reflow.
