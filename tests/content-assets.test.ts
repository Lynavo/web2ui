import { describe, expect, it, vi } from "vitest";
import {
  MAX_ASSET_BYTES,
  buildAssetWarnings,
  collectAssetNodeIds,
  markUnresolvedImageNodes,
  normalizeCaptureAsset,
  normalizeMediaType,
  partitionCaptureInlineAssets,
  tintSvgMarkup,
} from "../src/extension/content-assets.js";
import type { CaptureElementNode } from "../src/core/contracts/capture.js";

const svgRequest = {
  assetId: "asset_mask",
  sourceKind: "svg-image" as const,
  tint: "#1266cc",
};

describe("content asset resolution", () => {
  it("partitions optional inline assets behind page imagery", () => {
    const first = {
      assetId: "primary",
      kind: "svg-inline" as const,
      data: "<svg/>",
      mediaType: "image/svg+xml",
    };
    const optional = {
      assetId: "optional-glyph",
      kind: "raster-image" as const,
      data: "data:image/png;base64,aGk=",
      mediaType: "image/png",
      deferred: true,
    };

    expect(partitionCaptureInlineAssets([first, optional])).toEqual({
      primary: [first],
      deferred: [optional],
    });
  });

  it("marks unresolved image nodes for bounded screenshot recovery", () => {
    const root: CaptureElementNode = {
      id: "root",
      type: "element",
      tag: "body",
      name: "body",
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      opacity: 1,
      clipsContent: false,
      fills: [],
      children: [
        {
          id: "resolved-image",
          type: "image",
          tag: "img",
          name: "resolved",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          opacity: 1,
          clipsContent: false,
          assetId: "resolved",
          scaleMode: "fill",
        },
        {
          id: "missing-image",
          type: "image",
          tag: "img",
          name: "missing",
          bounds: { x: 100, y: 0, width: 100, height: 100 },
          opacity: 1,
          clipsContent: false,
          assetId: "missing",
          scaleMode: "fill",
        },
      ],
    };

    markUnresolvedImageNodes(root, [
      {
        assetId: "resolved",
        kind: "raster-image",
        data: "data:image/png;base64,aGk=",
        mediaType: "image/png",
        byteSize: 2,
      },
    ]);

    expect(root.children[0]).not.toHaveProperty("assetMissing");
    expect(root.children[1]).toMatchObject({ assetMissing: true });
  });

  it("maps shared assets to every affected capture node and scopes warnings", () => {
    const root: CaptureElementNode = {
      id: "root",
      type: "element",
      tag: "body",
      name: "body",
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      opacity: 1,
      clipsContent: false,
      fills: [{ type: "image", assetId: "shared", scaleMode: "fill" }],
      children: [
        {
          id: "image",
          type: "image",
          tag: "img",
          name: "image",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          opacity: 1,
          clipsContent: false,
          assetId: "shared",
          scaleMode: "fill",
        },
      ],
    };

    const nodeIds = collectAssetNodeIds(root);

    expect(buildAssetWarnings("asset_too_large", "shared", nodeIds)).toEqual([
      { code: "asset_too_large", nodeId: "root", count: 1, detail: "shared" },
      { code: "asset_too_large", nodeId: "image", count: 1, detail: "shared" },
    ]);
    expect(buildAssetWarnings("asset_fetch_failed", "orphan", nodeIds)).toEqual([
      { code: "asset_fetch_failed", count: 1, detail: "orphan" },
    ]);
  });

  it("treats response Content-Type as fact over a request hint", async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const asset = await normalizeCaptureAsset({
      assetId: svgRequest.assetId,
      sourceKind: svgRequest.sourceKind,
      bytes: png,
      mediaType: "image/png; charset=binary",
    });

    expect(normalizeMediaType(" IMAGE/PNG; charset=binary ")).toBe("image/png");
    expect(asset).toMatchObject({
      assetId: "asset_mask",
      kind: "raster-image",
      mediaType: "image/png",
      byteSize: 4,
    });
    expect(asset?.data).toBe("data:image/png;base64,iVBORw==");
  });

  it("uses the request kind only when Content-Type is unavailable", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>');
    const asset = await normalizeCaptureAsset({ ...svgRequest, bytes: svg, mediaType: "" });

    expect(asset?.kind).toBe("svg-image");
    expect(asset?.mediaType).toBe("image/svg+xml");
  });

  it("normalizes browser-decodable raster formats to PNG before clipboard export", async () => {
    const rasterize = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,aGk=",
      byteSize: 2,
      naturalWidth: 64,
      naturalHeight: 32,
    }));

    const asset = await normalizeCaptureAsset(
      {
        assetId: "asset_webp",
        sourceKind: "raster-image",
        bytes: Uint8Array.from([82, 73, 70, 70]),
        mediaType: "image/webp",
      },
      rasterize,
    );

    expect(rasterize).toHaveBeenCalledWith({
      bytes: Uint8Array.from([82, 73, 70, 70]),
      mediaType: "image/webp",
    });
    expect(asset).toMatchObject({
      assetId: "asset_webp",
      kind: "raster-image",
      mediaType: "image/png",
      data: "data:image/png;base64,aGk=",
      naturalWidth: 64,
      naturalHeight: 32,
    });
  });

  it("rasterizes narrowly safe styled SVGs and rejects active CSS", async () => {
    const rasterize = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,aGk=",
      byteSize: 2,
      naturalWidth: 24,
      naturalHeight: 24,
    }));
    const styled = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.icon{fill:#1266cc;stroke-width:2}</style><path class="icon" d="M0 0h24v24z"/></svg>',
    );

    await expect(
      normalizeCaptureAsset(
        {
          assetId: "styled-svg",
          sourceKind: "svg-image",
          bytes: styled,
          mediaType: "image/svg+xml",
        },
        rasterize,
      ),
    ).resolves.toMatchObject({ kind: "raster-image", mediaType: "image/png" });

    const activeCss = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://attacker.invalid/a.css"</style><path/></svg>',
    );
    await expect(
      normalizeCaptureAsset(
        {
          assetId: "unsafe-svg",
          sourceKind: "svg-image",
          bytes: activeCss,
          mediaType: "image/svg+xml",
        },
        rasterize,
      ),
    ).resolves.toBeNull();
    expect(rasterize).toHaveBeenCalledTimes(1);
  });

  it("rasterizes safe SVGs that use color functions Figma may not preserve", async () => {
    const rasterize = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,aGk=",
      byteSize: 2,
      naturalWidth: 20,
      naturalHeight: 20,
    }));
    const source = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="oklch(62% 0.2 250)"/></svg>',
    );

    const asset = await normalizeCaptureAsset(
      {
        assetId: "modern-color-svg",
        sourceKind: "svg-image",
        bytes: source,
        mediaType: "image/svg+xml",
      },
      rasterize,
    );

    expect(rasterize).toHaveBeenCalledOnce();
    expect(asset).toMatchObject({ kind: "raster-image", mediaType: "image/png" });
  });

  it("applies measured SVG mask tint while preserving fill=none", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/><path fill="none"/><circle style="fill:#000;stroke:none"/></svg>';
    const tinted = tintSvgMarkup(source, "#1266cc");

    expect(tinted).toContain('<svg fill="#1266cc"');
    expect(tinted).toContain('path fill="#1266cc"');
    expect(tinted).toContain('path fill="none"');
    expect(tinted).toContain("fill:#1266cc");
  });

  it("rejects unsafe SVG and a single asset beyond 4 MiB", async () => {
    const unsafe = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    await expect(
      normalizeCaptureAsset({ ...svgRequest, bytes: unsafe, mediaType: "image/svg+xml" }),
    ).resolves.toBeNull();

    const oversized = new Uint8Array(MAX_ASSET_BYTES + 1);
    await expect(
      normalizeCaptureAsset({
        assetId: svgRequest.assetId,
        sourceKind: "raster-image",
        bytes: oversized,
        mediaType: "image/png",
      }),
    ).resolves.toBeNull();
  });
});
