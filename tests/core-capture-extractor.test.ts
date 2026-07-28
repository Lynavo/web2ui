import {
  isCaptureDocument,
  decodeCaptureInlineAssetData,
  isSafeSvgMarkup,
  CAPTURE_CONTRACT_VERSION,
  type CaptureNode,
  type Paint,
} from "../src/core/contracts/capture.js";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { extractCaptureInPage, type InPageExtractionResult } from "../src/core/capture/in-page-extractor.js";

describe("extractCaptureInPage", () => {
  it("scopes an unresolved image warning to its placeholder node", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.setContent('<img id="missing" alt="Missing preview">');

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const missing = findNode(extraction.root, (node) => node.name === "img#missing");

      expect(missing).toMatchObject({ type: "image", assetMissing: true });
      expect(extraction.warnings).toContainEqual(
        expect.objectContaining({
          code: "asset_fetch_failed",
          nodeId: missing?.id,
          count: 1,
        }),
      );
    } finally {
      await browser.close();
    }
  });

  it("unescapes CSS image URLs and records measured background image facts", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      const nbsp = "\u00a0";
      await page.setContent(String.raw`
        <!doctype html>
        <style>
          body { margin: 0; }
          #media-control {
            width: 250px;
            height: 30px;
            background-image: url('data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" data-ordinary=\"a\_b\" data-hex=\"\66 oo\" data-nbsp=\"\41${nbsp}x\" data-continuation=\"line\
break\" width=\"20\" height=\"20\"%3E%3Cpath d=\"M0 0h20v20H0z\"/%3E%3C/svg%3E');
            background-repeat: no-repeat;
            background-position: 10px 50%;
            background-size: auto;
          }
          #mask-icon {
            width: 20px;
            height: 20px;
            background-color: rgb(0 102 204);
            -webkit-mask-image: url('data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"%3E%3Cpath fill=\"currentColor\" d=\"M0 0h20v20H0z\"/%3E%3C/svg%3E');
          }
        </style>
        <div id="media-control"></div>
        <div id="mask-icon"></div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const mediaControl = findNode(extraction.root, (node) => node.name === "div#media-control");
      if (mediaControl?.type !== "element") throw new Error("expected media control element");
      const imagePaint = mediaControl.fills.find((paint) => paint.type === "image");
      if (imagePaint?.type !== "image") throw new Error("expected background image paint");

      expect(imagePaint.repeat).toBe("no-repeat");
      expect(imagePaint.backgroundPosition).toEqual({
        x: { offsetPx: 10 },
        y: { percentage: 0.5 },
      });
      expect(imagePaint.naturalWidth).toBe(20);
      expect(imagePaint.naturalHeight).toBe(20);

      const backgroundAsset = extraction.inlineAssets.find(
        (asset) => asset.assetId === imagePaint.assetId,
      );
      expect(backgroundAsset?.naturalWidth).toBe(20);
      expect(backgroundAsset?.naturalHeight).toBe(20);
      const backgroundBytes = decodeCaptureInlineAssetData(
        backgroundAsset?.data ?? "",
        backgroundAsset?.mediaType ?? "",
      );
      expect(backgroundBytes).not.toBeNull();
      const backgroundMarkup = new TextDecoder().decode(backgroundBytes!);
      expect(backgroundMarkup).toContain('data-ordinary="a_b"');
      expect(backgroundMarkup).toContain('data-hex="foo"');
      expect(backgroundMarkup).toContain(`data-nbsp="A${nbsp}x"`);
      expect(backgroundMarkup).toContain('data-continuation="linebreak"');
      expect(isSafeSvgMarkup(backgroundMarkup)).toBe(true);

      const maskIcon = findNode(extraction.root, (node) => node.name === "div#mask-icon");
      if (maskIcon?.type !== "element") throw new Error("expected mask icon element");
      const maskPaint = maskIcon.fills.find((paint) => paint.type === "image");
      if (maskPaint?.type !== "image") throw new Error("expected mask image paint");
      const maskAsset = extraction.inlineAssets.find((asset) => asset.assetId === maskPaint.assetId);
      expect(maskAsset).toBeDefined();
      expect(maskAsset?.data).not.toContain('\\"');
      expect(isSafeSvgMarkup(maskAsset?.data ?? "")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("cycles shorter background property lists across every image layer", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      const svg = (width: number) =>
        `data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22${width}%22 height=%22${width}%22%3E%3C/svg%3E`;
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #layers {
            width: 200px;
            height: 100px;
            background-image: url("${svg(10)}"), url("${svg(20)}"), url("${svg(30)}"), url("${svg(40)}");
            background-repeat: no-repeat, repeat;
            background-position: 1px 10%, 2px 20%;
            background-size: 11px 12px, 21px 22px;
          }
        </style>
        <div id="layers"></div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const layers = findNode(extraction.root, (node) => node.name === "div#layers");
      if (layers?.type !== "element") throw new Error("expected layered element");
      const imagePaints = layers.fills.filter((paint) => paint.type === "image");
      const third = imagePaints.find((paint) => paint.naturalWidth === 30);
      const fourth = imagePaints.find((paint) => paint.naturalWidth === 40);
      if (third?.type !== "image" || fourth?.type !== "image") {
        throw new Error("expected third and fourth image paints");
      }
      expect(third.repeat).toBe("no-repeat");
      expect(third.backgroundPosition).toEqual({
        x: { offsetPx: 1 },
        y: { percentage: 0.1 },
      });
      expect(third.tileSizePx).toEqual({ width: 11, height: 12 });
      expect(fourth.repeat).toBe("repeat");
      expect(fourth.backgroundPosition).toEqual({
        x: { offsetPx: 2 },
        y: { percentage: 0.2 },
      });
      expect(fourth.tileSizePx).toEqual({ width: 21, height: 22 });
    } finally {
      await browser.close();
    }
  });

  it("degrades space and round background repeats without inventing exact repeat facts", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #spaced {
            width: 100px;
            height: 40px;
            background-image: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22%3E%3C/svg%3E");
            background-repeat: space round;
            background-size: 10px 10px;
          }
        </style>
        <div id="spaced"></div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const spaced = findNode(extraction.root, (node) => node.name === "div#spaced");
      if (spaced?.type !== "element") throw new Error("expected spaced background element");
      const paint = spaced.fills.find((fill) => fill.type === "image");
      if (paint?.type !== "image") throw new Error("expected spaced background paint");
      expect(paint.scaleMode).toBe("tile");
      expect(paint.repeat).toBeUndefined();
      expect(
        extraction.warnings.some(
          (warning) =>
            warning.code === "unsupported_paint" &&
            warning.detail?.includes("background-repeat") === true,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("preserves fully transparent gradient stop RGB without emitting transparent solid fills", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          .sample { width: 40px; height: 40px; }
          #linear { background: linear-gradient(rgba(255, 0, 0, 0), rgb(255, 0, 0)); }
          #radial {
            background: radial-gradient(
              circle,
              color(srgb 0 1 0 / 0),
              color(srgb 0 1 0)
            );
          }
          #conic { background: conic-gradient(transparent, black); }
          #extended {
            background: linear-gradient(color(srgb -2e-7 1.2 5e-1 / 0), black);
          }
          #solid { background-color: rgba(255, 0, 0, 0); }
        </style>
        <div id="linear" class="sample"></div>
        <div id="radial" class="sample"></div>
        <div id="conic" class="sample"></div>
        <div id="extended" class="sample"></div>
        <div id="solid" class="sample"></div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const cases = [
        {
          id: "linear",
          type: "linear-gradient",
          expected: { r: 1, g: 0, b: 0, a: 0 },
        },
        {
          id: "radial",
          type: "radial-gradient",
          expected: { r: 0, g: 1, b: 0, a: 0 },
        },
        {
          id: "conic",
          type: "conic-gradient",
          expected: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          id: "extended",
          type: "linear-gradient",
          expected: { r: 0, g: 1, b: 0.5, a: 0 },
        },
      ] as const;
      for (const testCase of cases) {
        const node = findNode(extraction.root, (candidate) =>
          candidate.name.startsWith(`div#${testCase.id}`),
        );
        if (node?.type !== "element") throw new Error(`expected ${testCase.id} element`);
        const gradient = node.fills.find((paint) => paint.type === testCase.type);
        if (
          gradient?.type !== "linear-gradient" &&
          gradient?.type !== "radial-gradient" &&
          gradient?.type !== "conic-gradient"
        ) {
          throw new Error(`expected ${testCase.type}`);
        }
        expect(gradient.stops[0]?.color).toEqual(testCase.expected);
      }

      const solid = findNode(extraction.root, (node) => node.name.startsWith("div#solid"));
      if (solid?.type !== "element") throw new Error("expected solid element");
      expect(solid.fills).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("measures text pseudo glyphs without overlapping the element text", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; font-family: Arial, sans-serif; }
          #toggle {
            display: inline-block;
            margin: 20px;
            font-size: 14px;
            line-height: 20px;
            background: white;
          }
          #toggle::before { content: "["; }
          #toggle::after { content: "]"; }
        </style>
        <span id="toggle">Display</span>
      `);
      const expectedBracketWidth = await page.$eval("#toggle", (element) => {
        const style = getComputedStyle(element, "::before");
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = style.font;
        return context.measureText("[").width;
      });
      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const toggle = findNode(extraction.root, (node) => node.name === "span#toggle");
      if (toggle?.type !== "element") throw new Error("expected toggle element");
      const before = toggle.children.find(
        (node) => node.type === "element" && node.pseudo === "before",
      );
      const after = toggle.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      const label = toggle.children.find((node) => node.type === "text" && node.text === "Display");
      if (before?.type !== "element" || after?.type !== "element" || label?.type !== "text") {
        throw new Error("expected text and pseudo nodes");
      }
      expect(before.bounds.width).toBeCloseTo(expectedBracketWidth, 5);
      expect(after.bounds.width).toBeCloseTo(expectedBracketWidth, 5);
      expect(before.bounds.x + before.bounds.width).toBeLessThanOrEqual(label.bounds.x + 0.01);
      expect(after.bounds.x + 0.01).toBeGreaterThanOrEqual(label.bounds.x + label.bounds.width);
    } finally {
      await browser.close();
    }
  });

  it("preserves a non-breaking space before an inline SVG icon", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; font: 16px/20px Arial, sans-serif; }
          #footer { margin: 20px; }
          svg { width: 10px; height: 10px; }
        </style>
        <div id="footer">
          <a href="#">View services<span>&nbsp;<svg viewBox="0 0 10 10"><path d="M1 1l4 4-4 4"></path></svg></span></a>
        </div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const footer = findNode(extraction.root, (node) => node.name === "div#footer");
      if (footer?.type !== "element") throw new Error("expected footer element");
      const label = footer.children.find((node) => node.type === "text");
      const icon = footer.children.find((node) => node.type === "svg");
      if (label?.type !== "text" || icon?.type !== "svg") {
        throw new Error("expected label and inline SVG");
      }

      expect(label.text).toBe("View services\u00a0");
      expect(label.segments.map((segment) => segment.text).join("")).toBe(
        "View services\u00a0",
      );
      expect(icon.bounds.x).toBeCloseTo(label.bounds.x + label.bounds.width, 5);
    } finally {
      await browser.close();
    }
  });

  it("omits ambiguous bottom-sticky pseudo flow with a warning", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #host {
            width: 208px;
            height: 100px;
            margin: 20px;
            overflow-y: auto;
          }
          #host::after {
            content: "";
            display: block;
            position: sticky;
            bottom: 0;
            left: 0;
            right: 0;
            height: 16px;
            background: linear-gradient(rgba(255, 255, 255, 0), white);
          }
          nav { margin: 0; }
          nav > div { height: 52px; margin-bottom: 32px; }
        </style>
        <div id="host"><nav><div></div></nav></div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const host = findNode(extraction.root, (node) => node.name === "div#host");
      if (host?.type !== "element") throw new Error("expected host element");
      const after = host.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      expect(after).toBeUndefined();
      expect(
        extraction.warnings.some(
          (warning) =>
            warning.code === "pseudo_unmeasurable" &&
            warning.detail?.includes("bottom-sticky") === true,
        ),
      ).toBe(true);
      expect(await page.locator("web2ui-capture-flow-probe").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("omits bottom-sticky pseudo flow when preserved whitespace contributes a line box", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #host {
            width: 208px;
            height: 100px;
            overflow-y: auto;
            white-space: pre;
            font: 16px/20px sans-serif;
          }
          #host::after {
            content: "";
            display: block;
            position: sticky;
            bottom: 0;
            width: 208px;
            height: 16px;
            background: linear-gradient(transparent, white);
          }
        </style>
        <div id="host"><div style="height: 70px"></div>
</div>
      `);
      await page.$eval("#host", (host) => {
        const state = window as unknown as { __captureChildMutations?: number };
        state.__captureChildMutations = 0;
        new MutationObserver((records) => {
          state.__captureChildMutations =
            (state.__captureChildMutations ?? 0) +
            records.filter((record) => record.type === "childList").length;
        }).observe(host, { childList: true, subtree: true });
      });

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const host = findNode(extraction.root, (node) => node.name === "div#host");
      if (host?.type !== "element") throw new Error("expected host element");

      expect(
        host.children.find((node) => node.type === "element" && node.pseudo === "after"),
      ).toBeUndefined();
      expect(
        extraction.warnings.some(
          (warning) =>
            warning.code === "pseudo_unmeasurable" &&
            warning.detail?.includes("bottom-sticky") === true,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __captureChildMutations?: number })
              .__captureChildMutations ?? -1,
        ),
      ).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("omits bottom-sticky pseudo flow when a generated before participates in flow", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #host { width: 208px; height: 100px; overflow-y: auto; }
          #host::before {
            content: "";
            display: block;
            width: 208px;
            height: 20px;
            background: red;
          }
          #host::after {
            content: "";
            display: block;
            position: sticky;
            bottom: 0;
            width: 208px;
            height: 16px;
            background: linear-gradient(transparent, white);
          }
        </style>
        <div id="host"><div style="height: 70px"></div></div>
      `);
      await page.$eval("#host", (host) => {
        const state = window as unknown as { __captureChildMutations?: number };
        state.__captureChildMutations = 0;
        new MutationObserver((records) => {
          state.__captureChildMutations =
            (state.__captureChildMutations ?? 0) +
            records.filter((record) => record.type === "childList").length;
        }).observe(host, { childList: true, subtree: true });
      });

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const host = findNode(extraction.root, (node) => node.name === "div#host");
      if (host?.type !== "element") throw new Error("expected host element");

      expect(
        host.children.find((node) => node.type === "element" && node.pseudo === "after"),
      ).toBeUndefined();
      expect(
        extraction.warnings.some(
          (warning) =>
            warning.code === "pseudo_unmeasurable" &&
            warning.detail?.includes("bottom-sticky") === true,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __captureChildMutations?: number })
              .__captureChildMutations ?? -1,
        ),
      ).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("measures simple bottom-sticky pseudo flow without mutating the DOM", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #host { width: 208px; height: 100px; overflow-y: auto; }
          #host::after {
            content: "";
            display: block;
            position: sticky;
            bottom: 0;
            width: 208px;
            height: 16px;
            background: linear-gradient(transparent, white);
          }
        </style>
        <div id="host"><div style="height: 70px"></div></div>
      `);
      await page.$eval("#host", (host) => {
        const state = window as unknown as { __captureChildMutations?: number };
        state.__captureChildMutations = 0;
        new MutationObserver((records) => {
          state.__captureChildMutations =
            (state.__captureChildMutations ?? 0) +
            records.filter((record) => record.type === "childList").length;
        }).observe(host, { childList: true, subtree: true });
      });

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const host = findNode(extraction.root, (node) => node.name === "div#host");
      if (host?.type !== "element") throw new Error("expected host element");
      const after = host.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );

      expect(after?.type).toBe("element");
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __captureChildMutations?: number })
              .__captureChildMutations ?? -1,
        ),
      ).toBe(0);
      expect(await page.locator("web2ui-capture-flow-probe").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("clamps a scroll-container bottom-sticky after from its static flow position", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #empty-host, #short-host, #tall-host, #flow-host {
            width: 208px;
            height: 100px;
            margin: 20px;
          }
          #complex-host {
            width: 208px;
            height: 100px;
            margin: 20px;
            overflow-y: auto;
          }
          #empty-host, #short-host, #tall-host { overflow-y: auto; }
          #empty-host::after, #short-host::after, #tall-host::after,
          #complex-host::after, #flow-host::after {
            content: "";
            display: block;
            position: sticky;
            bottom: 0;
            width: 208px;
            height: 16px;
            background: linear-gradient(transparent, white);
          }
        </style>
        <div id="empty-host"></div>
        <div id="short-host"><div style="width: 0; height: 70px; visibility: hidden"></div></div>
        <div id="tall-host"><div style="height: 90px"></div></div>
        <div id="complex-host">direct text<div style="height: 90px; position: relative"></div></div>
        <div id="flow-host"></div>
      `);
      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 80 },
      );
      const emptyHost = findNode(extraction.root, (node) => node.name === "div#empty-host");
      if (emptyHost?.type !== "element") throw new Error("expected empty scroll host");
      const emptyAfter = emptyHost.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      if (emptyAfter?.type !== "element") throw new Error("expected empty sticky pseudo");
      expect(emptyAfter.bounds.y).toBeCloseTo(emptyHost.bounds.y, 5);

      const shortHost = findNode(extraction.root, (node) => node.name === "div#short-host");
      if (shortHost?.type !== "element") throw new Error("expected short scroll host");
      const shortAfter = shortHost.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      if (shortAfter?.type !== "element") throw new Error("expected short sticky pseudo");
      expect(shortAfter.bounds.y).toBeCloseTo(shortHost.bounds.y + 70, 5);

      const tallHost = findNode(extraction.root, (node) => node.name === "div#tall-host");
      if (tallHost?.type !== "element") throw new Error("expected tall scroll host");
      const tallAfter = tallHost.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      if (tallAfter?.type !== "element") throw new Error("expected tall sticky pseudo");
      expect(tallAfter.bounds.y).toBeCloseTo(tallHost.bounds.y + tallHost.bounds.height - 16, 5);

      const complexHost = findNode(extraction.root, (node) => node.name === "div#complex-host");
      if (complexHost?.type !== "element") throw new Error("expected complex scroll host");
      const complexAfter = complexHost.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      expect(complexAfter).toBeUndefined();
      expect(
        extraction.warnings.some((warning) => warning.code === "pseudo_unmeasurable"),
      ).toBe(true);

      const flowHost = findNode(extraction.root, (node) => node.name === "div#flow-host");
      if (flowHost?.type !== "element") throw new Error("expected flow host");
      const flowAfter = flowHost.children.find(
        (node) => node.type === "element" && node.pseudo === "after",
      );
      if (flowAfter?.type !== "element") throw new Error("expected in-flow sticky pseudo");
      expect(flowAfter.bounds.y).toBeCloseTo(flowHost.bounds.y, 5);
    } finally {
      await browser.close();
    }
  });

  it("routes nontrivial masked subtrees through screenshot fallback", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #masked-values {
            width: 120px;
            height: 20px;
            -webkit-mask-image: linear-gradient(black, transparent);
            mask-image: linear-gradient(black, transparent);
          }
        </style>
        <div id="masked-values">
          <span>visible value</span>
          <span>transition value</span>
        </div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const masked = findNode(extraction.root, (node) => node.name === "div#masked-values");

      expect(masked).toMatchObject({
        type: "image",
        tag: "div",
        assetMissing: true,
      });
      expect(await page.getAttribute("#masked-values", "data-h2f-shot")).toBe(masked?.id);
      expect(
        extraction.warnings.some(
          (warning) => warning.code === "unsupported_paint" && warning.nodeId === masked?.id,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("routes hard-light text composites through backdrop-preserving screenshot fallback", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; }
          #stage { position: relative; width: 320px; height: 120px; }
          #backdrop { position: absolute; inset: 0; background: rgb(220, 40, 80); }
          h1 {
            position: absolute;
            inset: 0;
            width: 320px;
            height: 120px;
            margin: 0;
            font: 48px/1 sans-serif;
          }
          #background-title { color: rgb(30, 100, 70); }
          #foreground-title {
            color: rgba(0, 14, 255, 0.5);
            mix-blend-mode: hard-light;
            z-index: 2;
          }
        </style>
        <div id="stage">
          <div id="backdrop"></div>
          <h1 id="background-title">Revenue</h1>
          <h1 id="foreground-title">Revenue</h1>
        </div>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const foreground = findNode(
        extraction.root,
        (node) => node.name === "h1#foreground-title",
      );
      const background = findNode(
        extraction.root,
        (node) => node.name === "h1#background-title",
      );

      expect(foreground).toMatchObject({
        type: "image",
        tag: "h1",
        assetMissing: true,
        fallbackLabel: "backdrop-composite",
        positioned: true,
        zIndex: 2,
      });
      expect(background).toBeUndefined();
      expect(await page.getAttribute("#foreground-title", "data-h2f-shot")).toBe(foreground?.id);
      expect(
        await page.getAttribute("#background-title", "data-h2f-backdrop-source-for"),
      ).toBe(foreground?.id);
    } finally {
      await browser.close();
    }
  });

  it("does not emit paint for a pseudo collapsed by a singular transform", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #link { display: inline-block; position: relative; margin: 20px; }
          #link::before {
            content: "";
            position: absolute;
            left: 0;
            bottom: 0;
            width: 120px;
            height: 2px;
            background: currentColor;
            transform: scaleX(0);
            transform-origin: left center;
          }
        </style>
        <a id="link">status link</a>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const link = findNode(extraction.root, (node) => node.name === "a#link");
      if (link?.type !== "element") throw new Error("expected link element");

      expect(
        link.children.some((node) => node.type === "element" && node.pseudo === "before"),
      ).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("applies a nonzero pseudo scale to its measured paint bounds", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #link { display: inline-block; position: relative; margin: 20px; }
          #link::before {
            content: "";
            position: absolute;
            left: 0;
            bottom: 0;
            width: 120px;
            height: 2px;
            background: currentColor;
            transform: scaleX(.5);
            transform-origin: left center;
          }
        </style>
        <a id="link">status link</a>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const link = findNode(extraction.root, (node) => node.name === "a#link");
      if (link?.type !== "element") throw new Error("expected link element");
      const before = link.children.find(
        (node) => node.type === "element" && node.pseudo === "before",
      );
      if (before?.type !== "element") throw new Error("expected visible pseudo element");

      expect(before.bounds.width).toBeCloseTo(60, 4);
    } finally {
      await browser.close();
    }
  });

  it("bakes computed descendant transforms into serialized SVG assets", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          #icon .moving-part {
            transform: translate(4px, 6px) scale(.5);
            transform-origin: 10px 10px;
          }
        </style>
        <svg id="icon" width="20" height="20" viewBox="0 0 20 20">
          <path class="moving-part" d="M2 2h16v16H2z" fill="currentColor" />
        </svg>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 30 },
      );
      const icon = findNode(extraction.root, (node) => node.name === "svg#icon");
      if (icon?.type !== "svg" || icon.assetId === undefined) {
        throw new Error("expected serialized SVG node");
      }
      const asset = extraction.inlineAssets.find((candidate) => candidate.assetId === icon.assetId);

      expect(asset?.data).toMatch(/transform="matrix\([^"]+\)"/);
    } finally {
      await browser.close();
    }
  });

  it("clamps CSS gradient stop positions to the capture contract range", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <main>
          <section
            id="target"
            style="
              width: 320px;
              height: 180px;
              background:
                linear-gradient(180deg, rgb(0 2 64) 0%, rgb(0 0 0) 117%),
                linear-gradient(90deg, rgb(255 255 255 / 95%) 0%, rgb(255 255 255 / 57%) 300%),
                linear-gradient(180deg, rgb(0 0 0 / 0%) -8.14%, rgb(255 255 255 / 10%) 62.09%);
            "
          ></section>
        </main>
      `);

      const extraction = await page.evaluate<
        InPageExtractionResult,
        { maxNodes: number }
      >(extractCaptureInPage, { maxNodes: 20 });
      const paints = collectPaints(extraction.root).filter((paint) => paint.type === "linear-gradient");
      expect(paints.length).toBeGreaterThanOrEqual(3);
      for (const paint of paints) {
        if (paint.type !== "linear-gradient") continue;
        expect(paint.stops.every((stop) => stop.position >= 0 && stop.position <= 1)).toBe(true);
      }
      expect(
        paints.some(
          (paint) =>
            paint.type === "linear-gradient" &&
            paint.stops.some((stop) => stop.position === 0) &&
            paint.stops.some((stop) => stop.position === 1),
        ),
      ).toBe(true);

      expect(
        isCaptureDocument({
          schemaVersion: CAPTURE_CONTRACT_VERSION,
          captureId: "cap_gradient_clamp_test",
          sourceType: "chrome_capture",
          capturedAt: new Date().toISOString(),
          safeSourceLabel: "test.local",
          viewport: { widthPx: 640, heightPx: 360, deviceScaleFactor: 1 },
          page: { widthPx: extraction.pageWidth, heightPx: extraction.pageHeight, fullPage: true },
          pageBackground: extraction.pageBackground,
          root: extraction.root,
          assets: [],
          fonts: extraction.fonts,
          warnings: extraction.warnings,
          stats: {
            nodeCount: extraction.nodeCount,
            textNodeCount: extraction.textNodeCount,
            imageNodeCount: extraction.imageNodeCount,
            assetByteTotal: 0,
            captureDurationMs: 1,
          },
        }),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("does not merge positioned inline counters into the parent text run", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(`
        <!doctype html>
        <style>
          body { margin: 0; font-family: Arial, sans-serif; }
          #eyebrow {
            margin: 40px;
            font-size: 14px;
            line-height: 16.8px;
          }
          .counter {
            display: inline-block;
            position: relative;
            width: 88px;
            height: 18px;
            overflow: hidden;
            color: #64748b;
          }
          .counter-value { display: inline-block; }
          .counter-duplicate {
            position: absolute;
            left: 0;
            top: 18px;
            display: block;
          }
        </style>
        <div id="eyebrow">
          <span>Share of global GDP carried by Stripe:</span>
          <span class="counter">
            <span class="counter-value">1.677%</span>
            <span class="counter-duplicate">1.677%</span>
          </span>
        </div>
      `);

      const extraction = await page.evaluate<
        InPageExtractionResult,
        { maxNodes: number }
      >(extractCaptureInPage, { maxNodes: 40 });
      const texts = collectTextNodes(extraction.root).map((node) => node.text);

      expect(
        texts.some((text) => text.includes("GDP") && text.includes("1.677")),
      ).toBe(false);
      expect(texts.map((text) => text.trim())).toContain(
        "Share of global GDP carried by Stripe:",
      );
      expect(texts.filter((text) => text === "1.677%").length).toBeGreaterThanOrEqual(1);
      expect(texts.every((text) => !text.includes("\n"))).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("crops and normalizes nodes to the current viewport for Visible Area", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.setContent(`
        <!doctype html>
        <style>
          html, body { margin: 0; }
          body { position: relative; width: 640px; height: 900px; }
          #above, #top-edge, #inside, #bottom-edge, #below, #right-edge {
            position: absolute;
            width: 50px;
            background: tomato;
          }
          #above { left: 10px; top: 20px; height: 40px; }
          #top-edge { left: 15px; top: 280px; height: 50px; }
          #inside { left: 25px; top: 360px; width: 70px; height: 40px; }
          #bottom-edge { left: 35px; top: 480px; height: 50px; }
          #below { left: 45px; top: 600px; height: 50px; }
          #right-edge { left: 300px; top: 400px; width: 80px; height: 30px; }
          #wrapped {
            position: absolute;
            left: 120px;
            top: 450px;
            width: 64px;
            font: 16px/20px Arial, sans-serif;
          }
          #fixed { position: fixed; left: 240px; top: 12px; width: 60px; height: 24px; background: navy; }
        </style>
        <div id="above"></div>
        <div id="top-edge"></div>
        <div id="inside"></div>
        <div id="bottom-edge"></div>
        <div id="below"></div>
        <div id="right-edge"></div>
        <div id="wrapped">Alpha Bravo Charlie</div>
        <div id="fixed"></div>
      `);
      await page.evaluate(() => window.scrollTo(0, 300));

      const extraction = await page.evaluate<
        InPageExtractionResult,
        { maxNodes: number; viewportClip: { x: number; y: number; width: number; height: number } }
      >(extractCaptureInPage, {
        maxNodes: 50,
        viewportClip: { x: 0, y: 300, width: 320, height: 200 },
      });

      expect(extraction.pageWidth).toBe(320);
      expect(extraction.pageHeight).toBe(200);
      expect(extraction.root.bounds).toEqual({ x: 0, y: 0, width: 320, height: 200 });
      expect(findNode(extraction.root, (node) => node.name === "div#above")).toBeUndefined();
      expect(findNode(extraction.root, (node) => node.name === "div#below")).toBeUndefined();
      expect(findNode(extraction.root, (node) => node.name === "div#top-edge")?.bounds).toEqual({
        x: 15,
        y: -20,
        width: 50,
        height: 50,
      });
      expect(findNode(extraction.root, (node) => node.name === "div#inside")?.bounds).toEqual({
        x: 25,
        y: 60,
        width: 70,
        height: 40,
      });
      expect(findNode(extraction.root, (node) => node.name === "div#bottom-edge")?.bounds).toEqual({
        x: 35,
        y: 180,
        width: 50,
        height: 50,
      });
      expect(findNode(extraction.root, (node) => node.name === "div#right-edge")?.bounds).toEqual({
        x: 300,
        y: 100,
        width: 80,
        height: 30,
      });
      expect(findNode(extraction.root, (node) => node.name === "div#fixed")?.bounds).toEqual({
        x: 240,
        y: 12,
        width: 60,
        height: 24,
      });
      const wrappedText = findNode(
        extraction.root,
        (node) => node.type === "text" && node.text.includes("Alpha"),
      );
      if (wrappedText?.type !== "text" || wrappedText.measuredLines === undefined) {
        throw new Error("expected browser-measured wrapped text");
      }
      expect(wrappedText.measuredLines.length).toBeGreaterThan(1);
      expect(
        wrappedText.measuredLines.every(
          (line) => typeof line.text === "string" && line.text.length > 0,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("keeps complete page coordinates when Full Page is requested", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.setContent(`
        <!doctype html>
        <style>
          html, body { margin: 0; }
          body { position: relative; width: 640px; height: 900px; }
          #above, #inside, #below {
            position: absolute;
            width: 50px;
            height: 40px;
            background: tomato;
          }
          #above { left: 10px; top: 20px; }
          #inside { left: 25px; top: 360px; }
          #below { left: 45px; top: 600px; }
        </style>
        <div id="above"></div>
        <div id="inside"></div>
        <div id="below"></div>
      `);
      await page.evaluate(() => window.scrollTo(0, 300));

      const extraction = await page.evaluate<
        InPageExtractionResult,
        { maxNodes: number }
      >(extractCaptureInPage, { maxNodes: 50 });

      expect(extraction.pageWidth).toBe(640);
      expect(extraction.pageHeight).toBe(900);
      expect(extraction.root.bounds).toEqual({ x: 0, y: 0, width: 640, height: 900 });
      expect(findNode(extraction.root, (node) => node.name === "div#above")?.bounds.y).toBe(20);
      expect(findNode(extraction.root, (node) => node.name === "div#inside")?.bounds.y).toBe(360);
      expect(findNode(extraction.root, (node) => node.name === "div#below")?.bounds.y).toBe(600);
    } finally {
      await browser.close();
    }
  });

  it("attaches node-scoped warnings to local screenshot fallback regions", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.setContent(`
        <!doctype html>
        <style>
          html, body { margin: 0; }
          #glow {
            width: 120px;
            height: 80px;
            background: radial-gradient(circle, rgb(80 120 255), transparent 70%);
            filter: blur(24px);
            transform: rotate(12deg);
          }
        </style>
        <div id="glow"></div>
        <canvas id="scene" width="80" height="40"></canvas>
      `);

      const extraction = await page.evaluate<InPageExtractionResult, { maxNodes: number }>(
        extractCaptureInPage,
        { maxNodes: 20 },
      );
      const glow = findNode(extraction.root, (node) => node.name === "div#glow");

      expect(glow).toMatchObject({
        type: "image",
        assetMissing: true,
        fallbackLabel: "decorative-effect",
      });
      expect(extraction.warnings).toContainEqual(
        expect.objectContaining({
          code: "unsupported_filter",
          nodeId: glow?.id,
          count: 1,
        }),
      );
      const scene = findNode(extraction.root, (node) => node.name === "canvas#scene");
      expect(scene).toMatchObject({ type: "image", assetMissing: true });
      expect(extraction.warnings).toContainEqual(
        expect.objectContaining({
          code: "canvas_rasterized",
          nodeId: scene?.id,
          count: 1,
        }),
      );
    } finally {
      await browser.close();
    }
  });

});

function findNode(node: CaptureNode, predicate: (candidate: CaptureNode) => boolean): CaptureNode | undefined {
  if (predicate(node)) return node;
  if (node.type !== "element") return undefined;
  for (const child of node.children) {
    const match = findNode(child, predicate);
    if (match !== undefined) return match;
  }
  return undefined;
}

function collectPaints(node: { fills?: Paint[]; children?: unknown[] }): Paint[] {
  const paints = [...(node.fills ?? [])];
  for (const child of node.children ?? []) {
    if (typeof child === "object" && child !== null) {
      paints.push(...collectPaints(child as { fills?: Paint[]; children?: unknown[] }));
    }
  }
  return paints;
}

function collectTextNodes(node: { type?: string; text?: string; children?: unknown[] }): Array<{ text: string }> {
  const nodes: Array<{ text: string }> = [];
  if (node.type === "text" && typeof node.text === "string") {
    nodes.push({ text: node.text });
  }
  for (const child of node.children ?? []) {
    if (typeof child === "object" && child !== null) {
      nodes.push(...collectTextNodes(child as { type?: string; text?: string; children?: unknown[] }));
    }
  }
  return nodes;
}
