# Changelog

All user-visible changes to Web2UI — Copy for Figma are recorded here.

## Unreleased

## 0.1.3 — 2026-08-02

- Recovered failed image and CSS-background assets with bounded, single-frame screenshots while
  preserving editable child layers; fallback slots now prioritize image nodes and larger regions.
- Normalized WebP, AVIF, safely styled SVG, modern-color SVG, and tinted raster assets to
  Figma-compatible PNG data before clipboard export, without increasing the public asset budget.
- Reserved the local asset budget for page imagery before optional generated glyphs and fixed
  transformed linear, radial, and angular gradients in the clipboard SVG.
- Added real Manifest V3 regression coverage that verifies page images and fallback screenshots
  remain embedded exactly once and never become external clipboard references.
- Preserved browser-measured legacy and image clipping, nested clip-path ownership, and
  positioned-auto paint order instead of flattening a larger page shell.
- Added bounded screenshot recovery for browser-resolved generated content such as CSS counters,
  including pseudo-element paint outside the host box. Thin unsupported masked decorations may be
  omitted with a scoped warning so their editable host content remains intact.
- Locked the measured capture viewport and preserved authored horizontal scroll positions while
  capturing nested fallback regions, preventing fallback pixels from being shifted by reflow or
  contaminated by neighboring content.

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
