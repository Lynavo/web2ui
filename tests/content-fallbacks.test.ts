import { describe, expect, it, vi } from "vitest";
import type {
  CaptureAsset,
  CaptureElementNode,
  CaptureImageNode,
  CaptureNode,
} from "../src/core/contracts/capture.js";
import {
  CAPTURE_MARKER_ATTRIBUTES,
  LOCAL_STATIC_PROFILE_ID,
  LOCAL_STATIC_SCREENSHOT_LIMIT,
  applyScreenshotFallbackAsset,
  captureAncestorScrollPositions,
  cleanupCaptureMarkers,
  collectScreenshotFallbackNodes,
  findCaptureMarker,
  localStaticSettleDelayMs,
  planScreenshotFallbackAttempts,
  resolveLocalStaticScreenshotFallbacks,
  restoreAncestorHorizontalScroll,
  restoreAncestorScrollPositions,
  screenshotFallbackPageClip,
  type ScreenshotFallbackNode,
} from "../src/extension/content-fallbacks.js";

function image(id: string, fallbackLabel: string): CaptureImageNode {
  return {
    id,
    type: "image",
    tag: "canvas",
    name: id,
    bounds: { x: 10, y: 20, width: 100, height: 60 },
    opacity: 1,
    clipsContent: false,
    assetMissing: true,
    fallbackLabel,
    scaleMode: "fill",
  };
}

function root(children: CaptureNode[]): CaptureElementNode {
  return {
    id: "root",
    type: "element",
    tag: "body",
    name: "body",
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    opacity: 1,
    clipsContent: true,
    fills: [],
    children,
  };
}

describe("content screenshot fallbacks", () => {
  it("collects an unresolved CSS background without replacing its editable children", () => {
    const backgroundHost: CaptureElementNode = {
      id: "background-host",
      type: "element",
      tag: "article",
      name: "article",
      bounds: { x: 10, y: 20, width: 320, height: 180 },
      opacity: 1,
      clipsContent: false,
      fills: [{ type: "image", assetId: "missing-background", scaleMode: "fill" }],
      children: [
        {
          id: "copy",
          type: "text",
          tag: "#text",
          name: "Editable copy",
          bounds: { x: 30, y: 40, width: 120, height: 24 },
          opacity: 1,
          clipsContent: false,
          text: "Editable copy",
          segments: [],
          style: {
            fontFamily: "Inter",
            fontFamilyStack: "Inter, sans-serif",
            fontSizePx: 16,
            fontWeight: 400,
            italic: false,
            lineHeightPx: 24,
            letterSpacingPx: 0,
            textAlign: "left",
            textTransform: "none",
            textDecoration: "none",
            color: { r: 0, g: 0, b: 0, a: 1 },
          },
        },
      ],
    };

    const nodes = collectScreenshotFallbackNodes(
      root([backgroundHost]),
      new Set<string>(),
    );

    expect(nodes).toEqual([
      {
        nodeId: "background-host",
        rect: backgroundHost.bounds,
        tag: "article",
        preserveBackdrop: false,
        kind: "background-host",
      },
    ]);
  });

  it("uses the public local-static limits without a second capture profile seam", () => {
    expect(LOCAL_STATIC_PROFILE_ID).toBe("local-static-v1");
    expect(LOCAL_STATIC_SCREENSHOT_LIMIT).toBe(12);
    expect(localStaticSettleDelayMs("canvas")).toBe(120);
    expect(localStaticSettleDelayMs("div")).toBe(60);
  });

  it("captures each attempted region once and marks over-budget regions explicitly", async () => {
    const tree = root(
      Array.from({ length: 15 }, (_, index) => image(`node-${index}`, "canvas")),
    );
    const assets: CaptureAsset[] = [];
    const capture = vi.fn<
      (request: ScreenshotFallbackNode) => Promise<string | null>
    >(async () => "data:image/png;base64,aGk=");

    const result = await resolveLocalStaticScreenshotFallbacks({
      root: tree,
      assets,
      capture,
      maxAssetBytes: 100,
      maxTotalAssetBytes: 1_000,
    });

    expect(capture).toHaveBeenCalledTimes(12);
    expect(capture.mock.calls.map(([request]) => request.nodeId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `node-${index}`),
    );
    expect(result).toMatchObject({
      attemptedCount: 12,
      appliedCount: 12,
      failures: [
        { nodeId: "node-12", reason: "deferred" },
        { nodeId: "node-13", reason: "deferred" },
        { nodeId: "node-14", reason: "deferred" },
      ],
    });
    expect(result.warnings).toEqual([
      {
        code: "dynamic_frame_unavailable",
        nodeId: "node-12",
        count: 1,
        detail: "local-static-v1 12-region limit",
      },
      {
        code: "dynamic_frame_unavailable",
        nodeId: "node-13",
        count: 1,
        detail: "local-static-v1 12-region limit",
      },
      {
        code: "dynamic_frame_unavailable",
        nodeId: "node-14",
        count: 1,
        detail: "local-static-v1 12-region limit",
      },
    ]);
    expect(assets).toHaveLength(12);
    expect(tree.children[12]).toMatchObject({
      renderFallback: true,
      fallbackLabel: "local-static-v1 12-region limit",
      rasterCapture: { status: "unavailable", sampleCount: 0 },
    });
  });

  it("prioritizes image nodes and then larger regions within the fixed limit", () => {
    const requests: ScreenshotFallbackNode[] = [
      {
        nodeId: "small-background",
        rect: { x: 0, y: 0, width: 40, height: 40 },
        tag: "span",
        preserveBackdrop: false,
        kind: "background-host",
      },
      {
        nodeId: "large-background",
        rect: { x: 0, y: 0, width: 400, height: 300 },
        tag: "section",
        preserveBackdrop: false,
        kind: "background-host",
      },
      {
        nodeId: "content-image",
        rect: { x: 0, y: 0, width: 120, height: 80 },
        tag: "img",
        preserveBackdrop: false,
        kind: "image-node",
      },
    ];

    const plan = planScreenshotFallbackAttempts(requests, 2);

    expect(plan.attempts.map((request) => request.nodeId)).toEqual([
      "content-image",
      "large-background",
    ]);
    expect(plan.deferred.map((request) => request.nodeId)).toEqual(["small-background"]);
  });

  it("marks a failed single-frame capture without retrying it", async () => {
    const tree = root([image("canvas", "canvas")]);
    const capture = vi.fn<
      (request: ScreenshotFallbackNode) => Promise<string | null>
    >(async () => null);

    const result = await resolveLocalStaticScreenshotFallbacks({
      root: tree,
      assets: [],
      capture,
      maxAssetBytes: 100,
      maxTotalAssetBytes: 100,
    });

    expect(capture).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([
      { nodeId: "canvas", reason: "capture-unavailable" },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic_frame_unavailable",
        nodeId: "canvas",
        count: 1,
        detail: "single-frame screenshot unavailable",
      },
    ]);
    expect(tree.children[0]).toMatchObject({
      renderFallback: true,
      fallbackLabel: "single-frame capture unavailable",
      rasterCapture: { status: "unavailable", sampleCount: 1 },
    });
  });

  it("retains asset-too-large as the failure code for an oversized screenshot", async () => {
    const tree = root([image("canvas", "canvas")]);

    const result = await resolveLocalStaticScreenshotFallbacks({
      root: tree,
      assets: [],
      capture: async () => "data:image/png;base64,aGk=",
      maxAssetBytes: 1,
      maxTotalAssetBytes: 100,
    });

    expect(result.failures).toEqual([
      { nodeId: "canvas", reason: "asset-too-large" },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "asset_too_large",
        nodeId: "canvas",
        count: 1,
        detail: "single-frame screenshot exceeded the local asset budget",
      },
    ]);
  });

  it("preserves backdrop composition without multi-shot alpha recovery", () => {
    const nodes = collectScreenshotFallbackNodes(
      root([
        image("canvas", "canvas"),
        image("decorative", "decorative-effect"),
        image("backdrop", "backdrop-composite"),
        { ...image("ordinary", "image"), tag: "img" },
      ]),
    );

    expect(nodes.map(({ nodeId, preserveBackdrop }) => [nodeId, preserveBackdrop])).toEqual([
      ["canvas", false],
      ["decorative", false],
      ["backdrop", true],
      ["ordinary", false],
    ]);
  });

  it("applies a bounded PNG asset to the matching capture node", () => {
    const tree = root([image("canvas", "canvas")]);
    const assets: CaptureAsset[] = [];
    const result = applyScreenshotFallbackAsset({
      root: tree,
      assets,
      nodeId: "canvas",
      dataUrl: "data:image/png;base64,aGk=",
      maxAssetBytes: 100,
      maxTotalAssetBytes: 100,
    });

    expect(result).toMatchObject({ applied: true, byteSize: 2 });
    expect(assets).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ assetId: "shot-canvas", opacity: 1 });
    expect((tree.children[0] as CaptureImageNode).assetMissing).toBeUndefined();
  });

  it("replaces only an unresolved background fill with its isolated screenshot", () => {
    const child = image("editable-child", "canvas");
    delete child.assetMissing;
    const backgroundHost: CaptureElementNode = {
      id: "background-host",
      type: "element",
      tag: "section",
      name: "section",
      bounds: { x: 0, y: 0, width: 240, height: 160 },
      opacity: 1,
      clipsContent: false,
      fills: [{ type: "image", assetId: "missing-background", scaleMode: "fill" }],
      children: [child],
    };
    const tree = root([backgroundHost]);
    const assets: CaptureAsset[] = [];

    const result = applyScreenshotFallbackAsset({
      root: tree,
      assets,
      nodeId: backgroundHost.id,
      dataUrl: "data:image/png;base64,aGk=",
      maxAssetBytes: 100,
      maxTotalAssetBytes: 100,
      kind: "background-host",
    });

    expect(result).toMatchObject({
      applied: true,
      assetId: "shot-background-background-host",
    });
    expect(backgroundHost.fills).toEqual([
      {
        type: "image",
        assetId: "shot-background-background-host",
        scaleMode: "fill",
      },
    ]);
    expect(backgroundHost.children).toEqual([child]);
  });

  it("resolves an unresolved background through the bounded local fallback flow", async () => {
    const backgroundHost: CaptureElementNode = {
      id: "background-host",
      type: "element",
      tag: "section",
      name: "section",
      bounds: { x: 20, y: 30, width: 240, height: 160 },
      opacity: 1,
      clipsContent: false,
      fills: [{ type: "image", assetId: "missing-background", scaleMode: "fill" }],
      children: [],
    };
    const tree = root([backgroundHost]);
    const capture = vi.fn<
      (request: ScreenshotFallbackNode) => Promise<string | null>
    >(async () => "data:image/png;base64,aGk=");

    const result = await resolveLocalStaticScreenshotFallbacks({
      root: tree,
      assets: [],
      capture,
      maxAssetBytes: 100,
      maxTotalAssetBytes: 100,
    });

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "background-host", kind: "background-host" }),
    );
    expect(result).toMatchObject({ attemptedCount: 1, appliedCount: 1, failures: [] });
    expect(backgroundHost.fills).toEqual([
      {
        type: "image",
        assetId: "shot-background-background-host",
        scaleMode: "fill",
      },
    ]);
  });

  it("cleans every temporary marker, including markers inside open shadow roots", () => {
    expect(CAPTURE_MARKER_ATTRIBUTES).toEqual([
      "data-h2f-shot",
      "data-h2f-background-shot",
      "data-h2f-backdrop-source-for",
    ]);
    const marked = { removeAttribute: vi.fn(), shadowRoot: null };
    const shadowMarked = { removeAttribute: vi.fn(), shadowRoot: null };
    const shadowRoot = {
      querySelectorAll: vi.fn((selector: string) => (selector === "*" ? [shadowMarked] : [shadowMarked])),
    };
    const host = { removeAttribute: vi.fn(), shadowRoot };
    const documentRoot = {
      querySelectorAll: vi.fn((selector: string) => (selector === "*" ? [marked, host] : [marked])),
    };

    cleanupCaptureMarkers(documentRoot as unknown as Document);

    expect(marked.removeAttribute).toHaveBeenCalledWith("data-h2f-shot");
    expect(marked.removeAttribute).toHaveBeenCalledWith("data-h2f-background-shot");
    expect(marked.removeAttribute).toHaveBeenCalledWith("data-h2f-backdrop-source-for");
    expect(shadowMarked.removeAttribute).toHaveBeenCalledWith("data-h2f-shot");
    expect(shadowMarked.removeAttribute).toHaveBeenCalledWith("data-h2f-background-shot");
    expect(shadowMarked.removeAttribute).toHaveBeenCalledWith("data-h2f-backdrop-source-for");
  });

  it("finds the marker that matches the fallback kind", () => {
    const background = {} as Element;
    const root = {
      querySelector: vi.fn((selector: string) =>
        selector.startsWith("[data-h2f-background-shot=") ? background : null,
      ),
      querySelectorAll: vi.fn(() => []),
    };

    expect(
      findCaptureMarker(
        "background-host",
        root as unknown as Document,
        "background-host",
      ),
    ).toBe(background);
    expect(root.querySelector).toHaveBeenCalledWith(
      '[data-h2f-background-shot="background-host"]',
    );
  });

  it("uses a stable live page clip and retains expanded captured paint bounds", () => {
    expect(
      screenshotFallbackPageClip(
        { x: 80, y: 1_200, width: 320, height: 180 },
        { x: 80, y: 100, width: 320, height: 180 },
        { x: 0, y: 900 },
      ),
    ).toEqual({ x: 80, y: 1_000, width: 320, height: 180 });
    expect(
      screenshotFallbackPageClip(
        { x: 56, y: 1_180, width: 368, height: 220 },
        { x: 80, y: 100, width: 320, height: 180 },
        { x: 0, y: 900 },
      ),
    ).toEqual({ x: 56, y: 1_180, width: 368, height: 220 });
  });

  it("restores nested horizontal scroll before capture and every axis afterward", () => {
    const outer = { parentElement: null, scrollLeft: 96, scrollTop: 24 };
    const inner = { parentElement: outer, scrollLeft: 42, scrollTop: 180 };
    const target = { parentElement: inner, scrollLeft: 0, scrollTop: 0 };
    const positions = captureAncestorScrollPositions(target as unknown as Element);

    outer.scrollLeft = 0;
    outer.scrollTop = 300;
    inner.scrollLeft = 0;
    inner.scrollTop = 260;
    restoreAncestorHorizontalScroll(positions);

    expect(outer).toMatchObject({ scrollLeft: 96, scrollTop: 300 });
    expect(inner).toMatchObject({ scrollLeft: 42, scrollTop: 260 });

    restoreAncestorScrollPositions(positions);
    expect(outer).toMatchObject({ scrollLeft: 96, scrollTop: 24 });
    expect(inner).toMatchObject({ scrollLeft: 42, scrollTop: 180 });
  });
});
