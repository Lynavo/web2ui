import { describe, expect, it } from "vitest";

import {
  CAPTURE_CONTRACT_VERSION,
  type CaptureDocument,
} from "../src/core/contracts/capture";
import {
  convertCaptureToPortableRenderPlan,
  convertCaptureToRenderPlan,
  figmaFontStyle,
  linearGradientTransform,
} from "../src/core/conversion/convert";

function makeCapture(): CaptureDocument {
  return {
    schemaVersion: CAPTURE_CONTRACT_VERSION,
    captureId: "cap_conversion",
    sourceType: "chrome_capture",
    capturedAt: "2026-07-13T00:00:00.000Z",
    safeSourceLabel: "example.test",
    viewport: { widthPx: 640, heightPx: 480, deviceScaleFactor: 1 },
    page: { widthPx: 640, heightPx: 900, fullPage: true },
    pageBackground: { r: 1, g: 1, b: 1, a: 1 },
    root: {
      id: "n_root",
      type: "element",
      tag: "body",
      name: "Page",
      bounds: { x: 0, y: 0, width: 640, height: 900 },
      opacity: 1,
      clipsContent: false,
      fills: [],
      children: [
        {
          id: "n_card",
          type: "element",
          tag: "section",
          name: "Card",
          bounds: { x: 100, y: 50, width: 320, height: 180 },
          opacity: 0.9,
          clipsContent: true,
          cornerRadii: {
            topLeft: 12,
            topRight: 12,
            bottomRight: 12,
            bottomLeft: 12,
          },
          fills: [
            { type: "solid", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.8 } },
            {
              type: "linear-gradient",
              angleDegrees: 90,
              stops: [
                { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
              ],
            },
          ],
          children: [
            {
              id: "n_title",
              type: "text",
              tag: "#text",
              name: "Title",
              bounds: { x: 112, y: 60, width: 160, height: 24 },
              opacity: 1,
              clipsContent: false,
              text: "Hello Figma",
              style: {
                fontFamily: "Inter",
                fontFamilyStack: "Inter, sans-serif",
                fontSizePx: 16,
                fontWeight: 600,
                italic: false,
                lineHeightPx: 24,
                letterSpacingPx: 0.2,
                color: { r: 0.9, g: 0.8, b: 0.7, a: 1 },
                textAlign: "center",
                textDecoration: "underline",
                textTransform: "none",
              },
              segments: [
                {
                  text: "Hello Figma",
                  style: {
                    fontFamily: "Inter",
                    fontFamilyStack: "Inter, sans-serif",
                    fontSizePx: 16,
                    fontWeight: 600,
                    italic: false,
                    lineHeightPx: 24,
                    letterSpacingPx: 0.2,
                    color: { r: 0.9, g: 0.8, b: 0.7, a: 1 },
                    textAlign: "center",
                    textDecoration: "underline",
                    textTransform: "none",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    assets: [],
    fonts: [{ family: "Inter", weightsUsed: [600], italicUsed: false, loaded: true }],
    warnings: [],
    stats: {
      nodeCount: 3,
      textNodeCount: 1,
      imageNodeCount: 0,
      assetByteTotal: 0,
      captureDurationMs: 5,
    },
  };
}

describe("capture to render plan", () => {
  it("preserves relative geometry, paints, and editable text", () => {
    const plan = convertCaptureToRenderPlan(makeCapture());
    const card = plan.root.children[0];
    expect(card).toMatchObject({
      type: "FRAME",
      sourceNodeId: "n_card",
      x: 100,
      y: 50,
      width: 320,
      height: 180,
      opacity: 0.9,
      cornerRadius: 12,
    });
    if (card?.type !== "FRAME") throw new Error("expected converted frame");
    expect(card.fills).toMatchObject([
      {
        type: "SOLID",
        color: { r: 0.1, g: 0.2, b: 0.3 },
        opacity: 0.8,
      },
      {
        type: "GRADIENT_LINEAR",
        opacity: 1,
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
        ],
      },
    ]);

    const title = card.children[0];
    expect(title).toMatchObject({
      type: "TEXT",
      sourceNodeId: "n_title",
      x: 12,
      y: 10,
      characters: "Hello Figma",
      fontFamily: "Inter",
      fontStyle: "Semi Bold",
      fontSizePx: 16,
      lineHeightPx: 24,
      textAlignHorizontal: "CENTER",
      textDecoration: "UNDERLINE",
    });
    expect(plan.fonts).toEqual([
      { family: "Inter", styles: ["Semi Bold"], fallbackFamily: "Inter" },
    ]);
  });

  it("keeps deterministic gradient and font helpers", () => {
    const transform = linearGradientTransform(90, 100, 100);
    expect(transform[0][0]).toBeCloseTo(1);
    expect(transform[0][1]).toBeCloseTo(0);
    expect(transform[0][2]).toBeCloseTo(0);
    expect(transform[1][0]).toBeCloseTo(0);
    expect(transform[1][1]).toBeCloseTo(1);
    expect(transform[1][2]).toBeCloseTo(0);
    expect(figmaFontStyle(400, false)).toBe("Regular");
    expect(figmaFontStyle(700, true)).toBe("Bold Italic");
  });

  it("produces a portable plan without remote URLs", async () => {
    const capture = makeCapture();
    capture.assets = [
      {
        assetId: "asset_raster",
        kind: "raster-image",
        mediaType: "image/png",
        byteSize: 1,
        data: "data:image/png;base64,AA==",
      },
      {
        assetId: "asset_svg",
        kind: "svg-inline",
        mediaType: "image/svg+xml",
        byteSize: 64,
        data: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z" /></svg>',
      },
    ];
    capture.root.children.push({
      id: "n_image",
      type: "image",
      tag: "img",
      name: "Raster",
      bounds: { x: 0, y: 240, width: 10, height: 10 },
      opacity: 1,
      clipsContent: false,
      assetId: "asset_raster",
      scaleMode: "fill",
    });
    capture.root.children.push({
      id: "n_svg",
      type: "svg",
      tag: "svg",
      name: "Vector",
      bounds: { x: 20, y: 240, width: 10, height: 10 },
      opacity: 1,
      clipsContent: false,
      assetId: "asset_svg",
    });

    const plan = await convertCaptureToPortableRenderPlan(capture);
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]?.ref).toEqual({
      kind: "url",
      url: "data:image/png;base64,AA==",
    });
    expect(plan.root.children).toContainEqual(
      expect.objectContaining({
        type: "SVG",
        sourceNodeId: "n_svg",
        svgMarkup:
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z" /></svg>',
      }),
    );
    expect(JSON.stringify(plan.assets)).not.toMatch(/https?:\/\//u);
  });

  it("keeps a portable plan usable when a declared page asset could not be fetched", () => {
    const capture = makeCapture();
    capture.warnings.push({
      code: "asset_fetch_failed",
      nodeId: "n_missing",
      count: 1,
    });
    capture.root.children.push({
      id: "n_missing",
      type: "image",
      tag: "img",
      name: "Missing raster",
      bounds: { x: 0, y: 240, width: 10, height: 10 },
      opacity: 1,
      clipsContent: false,
      assetId: "asset_missing",
      scaleMode: "fill",
    });

    const plan = convertCaptureToPortableRenderPlan(capture);
    expect(plan.assets).toEqual([]);
    expect(plan.root.children[1]).toMatchObject({
      type: "RECTANGLE",
      sourceNodeId: "n_missing",
      fills: [
        {
          type: "SOLID",
          color: { r: 0.93, g: 0.93, b: 0.94 },
        },
      ],
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        capture.warnings[0],
        expect.objectContaining({
          code: "asset_fetch_failed",
          nodeId: "n_missing",
          detail: "image placeholder emitted",
        }),
      ]),
    );
  });

  it("wraps a clipped image in the browser-measured clip rectangle", () => {
    const capture = makeCapture();
    capture.assets.push({
      assetId: "asset_clipped",
      kind: "raster-image",
      mediaType: "image/png",
      byteSize: 1,
      data: "data:image/png;base64,AA==",
    });
    capture.root.children.push({
      id: "n_clipped_image",
      type: "image",
      tag: "img",
      name: "Clipped image",
      bounds: { x: 40, y: 30, width: 200, height: 100 },
      clipBounds: { x: 60, y: 40, width: 130, height: 70 },
      opacity: 1,
      clipsContent: false,
      assetId: "asset_clipped",
      scaleMode: "fill",
    });

    const plan = convertCaptureToRenderPlan(capture);
    const clipped = plan.root.children[1];

    expect(clipped).toMatchObject({
      type: "FRAME",
      sourceNodeId: "n_clipped_image",
      x: 60,
      y: 40,
      width: 130,
      height: 70,
      clipsContent: true,
      children: [
        {
          type: "RECTANGLE",
          x: -20,
          y: -10,
          width: 200,
          height: 100,
        },
      ],
    });
  });

  it("preserves both fallback diagnostics for one node so the UI can count the region once", () => {
    const capture = makeCapture();
    capture.warnings = [
      {
        code: "unsupported_filter",
        nodeId: "n_deferred",
        count: 1,
        detail: "browser-composited screenshot fallback",
      },
    ];
    capture.root.children.push({
      id: "n_deferred",
      type: "image",
      tag: "div",
      name: "Deferred decoration",
      bounds: { x: 0, y: 240, width: 120, height: 80 },
      opacity: 1,
      clipsContent: false,
      assetMissing: true,
      renderFallback: true,
      fallbackLabel: "local-static-v1 12-region limit",
      rasterCapture: { status: "unavailable", sampleCount: 0 },
      scaleMode: "fill",
    });

    const plan = convertCaptureToRenderPlan(capture);
    expect(plan.warnings.filter((warning) => warning.nodeId === "n_deferred")).toEqual([
      capture.warnings[0],
      {
        code: "asset_fetch_failed",
        nodeId: "n_deferred",
        count: 1,
        detail:
          "render fallback placeholder emitted: local-static-v1 12-region limit",
      },
    ]);
    expect(plan.root.children[1]).toMatchObject({
      type: "FRAME",
      sourceNodeId: "n_deferred",
      name: "Dynamic content fallback: local-static-v1 12-region limit",
    });
  });
});
