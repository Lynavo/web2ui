import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionState } from "../src/extension/state-machine.js";
import { App, PopupView } from "../src/extension/popup/app.js";

const callbacks = {
  onViewportChange: vi.fn(),
  onThemeChange: vi.fn(),
  onCapture: vi.fn(),
  onCopy: vi.fn(),
  onClear: vi.fn(),
};

function render(state: ExtensionState) {
  return renderToStaticMarkup(
    <PopupView
      state={state}
      viewport="browser"
      theme="browser"
      browserViewportWidth={null}
      copyStatus="idle"
      version="0.1.3"
      {...callbacks}
    />,
  );
}

describe("PopupView", () => {
  it("renders an offline visual preview without Chrome extension globals", () => {
    expect(() => renderToStaticMarkup(<App />)).not.toThrow();
  });

  it("renders in regular Chrome where window.chrome exists without extension APIs", () => {
    const previous = globalThis.chrome;
    Object.assign(globalThis, { chrome: {} });
    try {
      expect(() => renderToStaticMarkup(<App />)).not.toThrow();
    } finally {
      Object.assign(globalThis, { chrome: previous });
    }
  });

  it("offers only Visible Area and Full Page before capture", () => {
    const markup = render({ status: "idle" });

    expect(markup).toContain("Visible Area");
    expect(markup).toContain("Full Page");
    expect(markup).toContain("Capture visible area");
    expect(markup).toContain("Browser viewport");
    expect(markup).toContain("Browser theme");
    expect(markup).toContain("Web2UI Cloud");
    expect(markup).toContain('href="https://web2ui.lynavo.io/"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).not.toMatch(/Selection|Send to Figma|Sign in|credits?/iu);
  });

  it("keeps the complete popup visual structure without SaaS controls", () => {
    const markup = render({ status: "idle" });

    expect(markup).toContain('class="root"');
    expect(markup).toContain('class="topbar"');
    expect(markup).toContain('class="brand-logo"');
    expect(markup).toContain('class="env-card"');
    expect(markup).toContain('class="mode-row"');
    expect(markup).toContain('class="mode-primary"');
    expect(markup).toContain('class="mode-secondary"');
    expect(markup).toContain('class="guide-card"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toMatch(/masthead|hero-copy|mode-switch|local-badge|local-meta|brand-subtitle/u);
    expect(markup).not.toMatch(/Upgrade|FREE|PRO|account|billing|credits?/iu);
  });

  it("uses the Web2UI white and indigo design tokens", () => {
    const cssPath = fileURLToPath(new URL("../src/extension/popup/styles.css", import.meta.url));
    const css = readFileSync(cssPath, "utf8");

    expect(css).toContain("--bg: #fafafa");
    expect(css).toContain("--surface: #ffffff");
    expect(css).toContain("--accent: #4f46e5");
    expect(css).toContain("border-radius: 16px");
    expect(css).toMatch(/\.brand-logo\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/su);
    expect(css).toMatch(/\.topbar\s*\{[^}]*padding:\s*12px 16px;/su);
    expect(css).toMatch(/\.env-grid-2\s*\{[^}]*grid-template-columns:\s*1fr 1fr;/su);
    expect(css).toMatch(/\.mode-row\s*\{[^}]*gap:\s*10px;[^}]*height:\s*120px;/su);
    expect(css).toMatch(/\.mode-primary\s*\{[^}]*flex:\s*4;/su);
    expect(css).toMatch(/\.mode-secondary\s*\{[^}]*flex:\s*3;/su);
    expect(css).toMatch(
      /\.result-copy-card\s*\{[^}]*min-height:\s*88px;[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 32px;[^}]*border-radius:\s*22px;/su,
    );
    expect(css).toMatch(/\.result-card-arrow\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/su);
    expect(css).not.toContain("min-height: 204px");
    expect(css).not.toContain(".mode-viewport");
    expect(css).not.toMatch(/--paper|--signal|Iowan Old Style|Palatino/u);
  });

  it("makes Copy for Figma the only primary delivery when ready", () => {
    const markup = render({
      status: "ready",
      runId: "run_ready",
      tabId: 7,
      documentId: "document_ready",
      mode: "visible-area",
      createdAt: 1_000,
      expiresAt: 1_000 + 24 * 60 * 60 * 1_000,
      warningCount: 2,
    });

    expect(markup).toContain("Copy for Figma");
    expect(markup).toContain("Capture another page");
    expect(markup).toContain("Clear local data");
    expect(markup).toContain("Stored locally for up to 24 hours");
    expect(markup).toContain("2 visual details used a safe approximation.");
    expect(markup).toContain("Higher fidelity with Web2UI Cloud");
    expect(markup).toMatch(/class="[^"]*\bresult-view\b[^"]*"/u);
    expect(markup).toContain('class="result-copy-card"');
    expect(markup).toContain('class="result-card-arrow"');
    expect(markup).not.toMatch(/upload|account|plugin/iu);
  });

  it("suggests managed capture only for local complexity failures", () => {
    const complexMarkup = render({
      status: "error",
      code: "plan-too-large",
      message: "The converted result is 28.0 MB, above the 25.0 MB local limit.",
    });
    const permissionMarkup = render({
      status: "error",
      code: "permission-denied",
      message: "Chrome denied access to this page.",
    });

    expect(complexMarkup).toContain("Try managed capture in Web2UI Cloud");
    expect(permissionMarkup).not.toContain("Try managed capture in Web2UI Cloud");
  });
});
