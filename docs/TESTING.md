# Testing guide

The repository tests the same seams used at runtime: contract validators, pure conversion
interfaces, injected adapters, and a real Manifest V3 browser flow.

## Validation levels

### Focused feedback

Run the nearest test while implementing:

```bash
pnpm exec vitest run tests/background-controller.test.ts
node --test tests/manifest-policy.test.mjs
```

Vitest owns TypeScript unit and E2E tests. Node's built-in test runner owns JavaScript build,
package, repository, manifest, and release-policy tests.

### Complete gate

```bash
pnpm validate
```

The complete gate runs:

1. production build;
2. TypeScript checking;
3. ESLint;
4. Node policy/build tests;
5. Vitest unit tests;
6. the real Chromium extension flow;
7. final local-only release-boundary verification.

Run it before handing off any code, dependency, manifest, build, or release change.

### Release gate

```bash
pnpm audit
pnpm validate
pnpm package
```

Packaging rebuilds and verifies the extension, creates `out/releases/web2ui-extension-<version>.zip`,
writes its SHA-256 checksum, and generates an SPDX 2.3 production-dependency SBOM.

## Suite ownership

| Suite | What it protects |
| --- | --- |
| `core-capture-*.test.ts` | Browser measurement, sanitization, asset safety, and capture-contract facts. |
| `core-contracts.test.ts` | Runtime validation of CaptureDocument and RenderPlan. |
| `core-conversion*.test.ts` | Pure geometry, paint, text, assets, and clipboard output. |
| `content-*.test.ts` | Capture orchestration, scrolling, fallbacks, cleanup, and asset bounds. |
| `background-*.test.ts` | Privileged Chrome adapters and controller behavior. |
| `state-machine.test.ts` | Allowed state transitions and stale-run rejection. |
| `local-plan-store.test.ts` | IndexedDB validation, size limit, single-record policy, and expiry. |
| `popup-*.test.ts(x)` | Capture options, clipboard fallbacks, and rendered popup behavior. |
| `message-protocol.test.ts` | Strict popup/content message interfaces. |
| `*.test.mjs` | Build, manifest, repository, packaging, and release invariants. |
| `tests/e2e/local-copy-flow.test.ts` | Real visible/full-page capture, clipboard payloads, local-only traffic, and service-worker restart. |

## E2E artifacts

The browser test builds `dist/`, starts a loopback synthetic page, loads the unpacked extension in
Chromium, and writes evidence under:

```text
out/e2e/playwright/local-copy/
```

The test verifies both capture modes, popup behavior, viewport/theme choices, clipboard
preparation, result survival across a service-worker restart, and absence of capture data sent to
a Web2UI host. It also checks the raw clipboard SVG for exactly-once inline page assets, a recovered
CSS-background screenshot, the preservation of a nested horizontal scroller during a canvas
fallback, transparent pixels in an isolated single-frame asset, filtered background recovery,
fixed pixel canaries for the canvas frame and isolated backgrounds, and the absence of external
image references. Clipboard previews render in an independent clean browser so transient debugger
viewport emulation cannot corrupt the evidence. The browser profile and screenshots are disposable
and must not be committed.

## Writing reliable tests

- Prefer synthetic HTML and deterministic adapters over live websites.
- Test a module through its public interface; do not duplicate its implementation in assertions.
- Assert cleanup and failure behavior, not only success.
- Use explicit run, tab, and document identities in message tests.
- Keep conversion tests free of Chrome and filesystem dependencies.
- Keep captures, cookies, credentials, personal data, and third-party copyrighted page assets out
  of fixtures.
- For regressions, make the focused test fail before changing the implementation.

## Common failures

- **Chromium cannot launch:** ensure Playwright's Chromium is installed for the current lockfile
  and retry `pnpm install --frozen-lockfile`.
- **Extension does not reflect a rebuild:** reload its card on `chrome://extensions`; an already
  open popup may still belong to the previous service worker.
- **E2E timeout:** inspect the latest files under `out/e2e/playwright/local-copy/` and rerun the E2E
  file alone.
- **Release-boundary failure:** read the reported file and pattern. Do not relax a rule merely to
  pass; confirm whether the change violates local-only scope, manifest policy, or artifact
  hygiene. The reviewed commercial website link is allowlisted only in its source component and
  compiled popup; popup network primitives and the same origin elsewhere still fail closed.
