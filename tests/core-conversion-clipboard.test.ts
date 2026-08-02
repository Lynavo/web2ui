import { describe, expect, it } from "vitest";

import {
  RENDER_PLAN_CONTRACT_VERSION,
  type RenderPlan,
} from "../src/core/contracts/render-plan";
import {
  renderPlanToFigmaClipboardPayload,
  renderPlanToSvg,
} from "../src/core/conversion/clipboard-svg";

function makePlan(): RenderPlan {
  return {
    schemaVersion: RENDER_PLAN_CONTRACT_VERSION,
    renderPlanId: "rp_clipboard",
    sourceCaptureId: "cap_clipboard",
    sourceType: "chrome_capture",
    createdAt: "2026-07-13T00:00:00.000Z",
    safeSourceLabel: "example.test",
    page: {
      widthPx: 200,
      heightPx: 100,
      background: { r: 1, g: 1, b: 1, a: 1 },
    },
    root: {
      id: "rp_root",
      name: "Page",
      type: "FRAME",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      opacity: 1,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: "INSIDE",
      effects: [],
      clipsContent: true,
      children: [
        {
          id: "rp_image",
          name: "Raster",
          type: "RECTANGLE",
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          opacity: 1,
          fills: [
            {
              type: "IMAGE",
              assetId: "asset_raster",
              scaleMode: "FILL",
              opacity: 1,
            },
          ],
          strokes: [],
          strokeWeight: 0,
          strokeAlign: "INSIDE",
          effects: [],
        },
        {
          id: "rp_vector",
          name: "Vector",
          type: "SVG",
          x: 30,
          y: 0,
          width: 20,
          height: 20,
          opacity: 1,
          svgMarkup: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v20z" /></svg>',
        },
        {
          id: "rp_text",
          name: "Text",
          type: "TEXT",
          x: 0,
          y: 30,
          width: 200,
          height: 24,
          opacity: 1,
          characters: 'Safe <copy> & "paste"',
          fontFamily: 'Inter & "Fallback"',
          fontStyle: "Semi Bold",
          fontSizePx: 16,
          lineHeightPx: 24,
          letterSpacingPx: 0,
          fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
          textAlignHorizontal: "LEFT",
          textDecoration: "NONE",
          textCase: "ORIGINAL",
          textAutoResize: "NONE",
          effects: [],
        },
      ],
    },
    assets: [
      {
        assetId: "asset_raster",
        mediaType: "image/png",
        ref: { kind: "url", url: "data:image/png;base64,AA==" },
      },
    ],
    fonts: [{ family: "Inter", styles: ["Semi Bold"], fallbackFamily: "Inter" }],
    warnings: [],
    stats: {
      nodeCount: 4,
      textNodeCount: 1,
      assetCount: 1,
      conversionDurationMs: 0,
    },
  };
}

describe("Figma clipboard payload", () => {
  it("returns equivalent SVG, HTML, and plain-text clipboard representations", async () => {
    const payload = await renderPlanToFigmaClipboardPayload(makePlan());

    expect(payload.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    expect(payload.html).toBe(`<!doctype html><html><body>${payload.svg}</body></html>`);
    expect(payload.text).toBe(payload.svg);
    expect(payload.svg).toContain("data:image/png;base64,AA==");
    expect(payload.svg).toContain('<path d="M0 0h20v20z"');
    expect(payload.svg).toContain('Safe &lt;copy&gt; &amp; "paste"');
    expect(payload.svg).toContain('font-family="Inter &amp; &quot;Fallback&quot;"');
    expect(payload.svg).not.toContain("<script");
  });

  it("rejects external asset URLs even when an untrusted plan bypasses TypeScript", async () => {
    const plan = makePlan();
    const untrusted = structuredClone(plan) as unknown as {
      assets: Array<{ assetId: string; mediaType: string; ref: { kind: "url"; url: string } }>;
    };
    untrusted.assets[0]!.ref.url = "https://attacker.invalid/pixel.png";

    await expect(renderPlanToSvg(untrusted as unknown as RenderPlan)).rejects.toThrow(
      "clipboard SVG only accepts inline data assets",
    );
  });

  it("rejects unsafe inline SVG markup", async () => {
    const plan = makePlan();
    const vector = plan.root.children[1];
    if (vector?.type !== "SVG") throw new Error("expected vector fixture");
    vector.svgMarkup =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

    await expect(renderPlanToSvg(plan)).rejects.toThrow("clipboard SVG rejected unsafe markup");
  });

  it("converts Figma's node-to-gradient matrix to the inverse SVG transform", async () => {
    const plan = makePlan();
    const first = plan.root.children[0];
    if (first?.type !== "RECTANGLE") throw new Error("expected rectangle fixture");
    first.fills = [
      {
        type: "GRADIENT_LINEAR",
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
        gradientTransform: [
          [2, 0.5, 3],
          [0.25, 4, 5],
        ],
        opacity: 1,
      },
    ];

    const svg = await renderPlanToSvg(plan);

    expect(svg).toContain(
      'x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="matrix(0.51 -0.03 -0.06 0.25 -1.21 -1.17)"',
    );
  });
});
