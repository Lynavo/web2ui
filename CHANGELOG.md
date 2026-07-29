# Changelog

All user-visible changes to Web2UI — Copy for Figma are recorded here.

## Unreleased

- Isolated capture progress and errors by Chrome tab so switching tabs shows the correct local
  state and returning to a source tab restores its in-progress or ready view.
- Allowed independent capture sessions and completed local results in multiple tabs, with each
  source tab retaining its own RenderPlan.
- Prevented unsupported-page errors, unrelated tab navigation, and unrelated tab closure from
  deleting another tab's completed local result.
- Preserved the official 0.1.2 open-source popup UI while adding the multi-tab state isolation
  fixes, including the original **Copy for Figma** Capture Ready view and local-result controls.

## 0.1.2 — 2026-07-24

- Moved the public source, issue, security, and release links to `Lynavo/web2ui` after the
  repository rename.

## 0.1.1 — 2026-07-23

- Kept captures usable when a page-declared image, SVG, or CSS background cannot be recovered:
  missing image regions use a neutral placeholder, missing paints are omitted, and warnings remain
  attached instead of aborting the entire conversion.
- Replaced the generic “page was too complex” failure with distinct conversion, measured 25 MiB
  result-limit, and Chrome local-storage messages.
- Fixed false “The page changed during capture” failures on pages that update browser history while
  Full Page capture scrolls, while still stopping when the top-level document is actually replaced.
- Added an optional Web2UI Cloud website link, with contextual suggestions when local capture uses
  fidelity approximations or fails because the page is too complex for the public profile.
- Kept the commercial handoff user-initiated and link-only: no capture data, account state, or
  conversion request is sent by the extension.

## 0.1.0 — 2026-07-23

- Published the browser-safe capture contracts, DOM extractor, canonical conversion, and clipboard
  renderer while retaining the local-only data boundary.
- Preserved measured text lines, paint stacking, masks, fragment backgrounds, dynamic raster
  fallbacks, and viewport clipping in local Copy for Figma results.
- Reworked Full Page stabilization to revisit lazy regions, capture long narrow pages beyond the
  former 60-step limit, and stop at the initial frontier instead of chasing infinite feeds.
- Defined dynamic content as the documented `local-static-v1` profile: one current-frame sample
  per attempted fallback region, up to 12 regions, no animation convergence, and no multi-shot
  alpha recovery.

- Added local Visible Area and Full Page capture modes.
- Added a six-viewport/three-theme selector and balanced Full Page / Visible Area
  capture cards.
- Added browser-only capture-to-RenderPlan conversion and Copy for Figma clipboard output.
- Added one-result local storage with a 24-hour expiry and explicit clearing.
- Added AGPL-3.0 licensing, privacy documentation, deterministic release ZIP verification, and
  documented manual installation.
- Added scheduled deletion and fail-closed expiry for the local result after 24 hours.
