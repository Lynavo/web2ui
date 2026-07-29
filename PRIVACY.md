# Privacy policy

Effective date: July 13, 2026.

Web2UI — Copy for Figma processes the page selected by the user locally in the Chrome
extension. This policy describes the open-source extension only.

## Data processed

When the user starts a capture, the extension can read the selected page's DOM, page text,
computed styles, images, SVG, fonts, canvas or video frames, dimensions, and a redacted source
label. These facts are used only to produce the requested clipboard result.

## Local storage and deletion

Small UI preferences and per-tab capture status are stored with Chrome extension storage. The
status contains identifiers, progress, timestamps, warnings, and local error text, not captured
page content. Each source tab's portable RenderPlan is stored in IndexedDB under that tab's local
record, and every result becomes inaccessible after 24 hours.
An extension alarm schedules deletion at the next result deadline while the browser is running; if
the alarm is delayed because the browser is closed or suspended, the next extension activation
rejects and deletes expired results before they can be used. Starting a new capture replaces only
that source tab's result. Switching tabs does not cancel an active capture. Unsupported-page and
capture errors are isolated to their source tab and do not delete a ready result owned by another
tab. Interrupted and failed capture content is discarded.

## Network requests

Captured content is not uploaded to a Web2UI developer server. The extension may request an
image, SVG, font, or other asset from the current page or its CDN when the page declared that
asset and the browser cannot read it directly. Those page or asset hosts receive the normal
request metadata applied by Chrome and remain governed by their own privacy policies.

The extension does not use telemetry, analytics, advertising identifiers, crash reporting,
remote feature flags, or remotely hosted executable code. The maintainers do not sell captured
content or use it for advertising.

## Commercial edition link

The popup contains an optional link to the separate Web2UI Cloud website and may repeat that link
when local conversion reports a fidelity approximation or complexity-related failure. The site is
opened only after the user clicks the link. No captured page content, RenderPlan, clipboard
payload, account identifier, or conversion state is transferred by the extension. The destination
receives the ordinary request metadata sent by Chrome and is governed by its own privacy policy.

## Clipboard and Figma

The extension writes the result to the system clipboard only after the user clicks **Copy for
Figma**. When the user pastes into Figma, the clipboard content is provided to Figma under
Figma's own terms and privacy policy. The extension does not control data after that user-directed
paste.

## Permissions

The permission rationale in [README.md](README.md) is part of this policy. In particular,
`debugger` is used only for emulation and screenshot fallbacks during a user-initiated capture,
and `<all_urls>` is used only to operate on the current page and recover its declared assets.

Do not include private captures or sensitive page content in a public repository issue.
