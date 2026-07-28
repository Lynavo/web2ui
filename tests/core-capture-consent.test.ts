import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  hideConsentOverlaysInPage,
  restoreConsentOverlaysInPage,
  type ConsentOverlaySanitizerResult,
} from "../src/core/capture/consent-overlays.js";

describe("consent overlay sanitizer", () => {
  it("hides fixed cookie consent banners before capture and restores them afterwards", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <main>
          <h1>Product page</h1>
          <p id="body-copy">The content we want to capture.</p>
        </main>
        <section
          id="cookie-banner"
          style="
            position: fixed;
            left: 20px;
            right: 20px;
            bottom: 16px;
            z-index: 2147483000;
            background: white;
            border: 1px solid #ddd;
            padding: 18px;
          "
        >
          <p>We use cookies to improve your experience and understand product usage.</p>
          <button>Accept all</button>
          <button>Reject all</button>
        </section>
      `);

      const result = await page.evaluate<ConsentOverlaySanitizerResult>(
        hideConsentOverlaysInPage,
      );

      expect(result).toEqual({ hiddenCount: 1 });
      await expectDisplay(page, "#cookie-banner", "none");
      expect(await isVisible(page, "#body-copy")).toBe(true);

      const restored = await page.evaluate(restoreConsentOverlaysInPage);

      expect(restored).toEqual({ restoredCount: 1 });
      expect(await isVisible(page, "#cookie-banner")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("does not hide regular page content that mentions cookies", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <article id="article">
          <h1>Cookie recipes</h1>
          <p>This page mentions cookie policy examples but is normal content.</p>
        </article>
      `);

      const result = await page.evaluate<ConsentOverlaySanitizerResult>(
        hideConsentOverlaysInPage,
      );

      expect(result).toEqual({ hiddenCount: 0 });
      expect(await isVisible(page, "#article")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("hides common consent management platform containers by selector", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <main>Dashboard</main>
        <div id="onetrust-consent-sdk" style="position: fixed; inset: 0; z-index: 999999;">
          <div id="onetrust-banner-sdk">
            <p>We use cookies to improve your experience.</p>
            <button>Accept all</button>
          </div>
        </div>
      `);

      const result = await page.evaluate<ConsentOverlaySanitizerResult>(
        hideConsentOverlaysInPage,
      );

      expect(result).toEqual({ hiddenCount: 1 });
      await expectDisplay(page, "#onetrust-consent-sdk", "none");
    } finally {
      await browser.close();
    }
  });
});

async function expectDisplay(
  page: Page,
  selector: string,
  expected: string,
): Promise<void> {
  const display = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement ? getComputedStyle(element).display : null;
  }, selector);
  expect(display).toBe(expected);
}

async function isVisible(
  page: Page,
  selector: string,
): Promise<boolean> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }, selector);
}
