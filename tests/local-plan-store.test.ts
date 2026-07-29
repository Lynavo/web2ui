import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { RenderPlan } from "../src/core/contracts/render-plan.js";
import { RENDER_PLAN_CONTRACT_VERSION } from "../src/core/contracts/render-plan.js";
import {
  MAX_RENDER_PLAN_BYTES,
  RENDER_PLAN_TTL_MS,
  RenderPlanStore,
  RenderPlanTooLargeError,
} from "../src/extension/plan-store.js";

function buildPlan(id: string): RenderPlan {
  return {
    schemaVersion: RENDER_PLAN_CONTRACT_VERSION,
    renderPlanId: `rp_${id}`,
    sourceCaptureId: `cap_${id}`,
    sourceType: "chrome_capture",
    createdAt: "2026-07-13T00:00:00.000Z",
    safeSourceLabel: "fixture page",
    page: {
      widthPx: 1280,
      heightPx: 800,
      background: { r: 1, g: 1, b: 1, a: 1 },
    },
    root: {
      id: "rp_root",
      type: "FRAME",
      name: "fixture page",
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      opacity: 1,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: "INSIDE",
      effects: [],
      clipsContent: true,
      children: [],
    },
    assets: [],
    fonts: [],
    warnings: [],
    stats: {
      nodeCount: 1,
      textNodeCount: 0,
      assetCount: 0,
      conversionDurationMs: 1,
    },
  };
}

describe("RenderPlanStore", () => {
  it("stores portable RenderPlans independently for each tab", async () => {
    const indexedDB = new IDBFactory();
    const store = new RenderPlanStore({ indexedDB, dbName: "replace-plan" });

    await store.put(buildPlan("first"), {
      runId: "run_first",
      tabId: 7,
      documentId: "document_first",
      mode: "visible-area",
    });
    await store.put(buildPlan("second"), {
      runId: "run_second",
      tabId: 8,
      documentId: "document_second",
      mode: "full-page",
    });

    expect((await store.get(7))?.plan.renderPlanId).toBe("rp_first");
    expect((await store.get(8))?.plan.renderPlanId).toBe("rp_second");
    expect(await store.getAll()).toHaveLength(2);
  });

  it("removes each tab plan after the fixed 24 hour TTL", async () => {
    const indexedDB = new IDBFactory();
    let now = Date.UTC(2026, 6, 13, 0, 0, 0);
    const store = new RenderPlanStore({ indexedDB, dbName: "expired-plan", now: () => now });

    await store.put(buildPlan("expiring"), {
      runId: "run_expiring",
      tabId: 4,
      documentId: "document_expiring",
      mode: "visible-area",
    });
    expect((await store.get(4))?.expiresAt).toBe(now + RENDER_PLAN_TTL_MS);

    now += RENDER_PLAN_TTL_MS + 1;
    expect(await store.get(4)).toBeNull();
    expect(await store.get(4)).toBeNull();
  });

  it("rejects a plan beyond the 25 MiB production limit before writing", async () => {
    expect(MAX_RENDER_PLAN_BYTES).toBe(25 * 1024 * 1024);
    const indexedDB = new IDBFactory();
    const store = new RenderPlanStore({ indexedDB, dbName: "oversized-plan", maxBytes: 512 });
    const oversized = buildPlan("oversized");
    oversized.safeSourceLabel = "x".repeat(1_000);

    await expect(
      store.put(oversized, {
        runId: "run_oversized",
        tabId: 2,
        documentId: "document_oversized",
        mode: "full-page",
      }),
    ).rejects.toBeInstanceOf(RenderPlanTooLargeError);
    expect(await store.getCurrent()).toBeNull();
  });

  it("clears one tab plan explicitly", async () => {
    const store = new RenderPlanStore({ indexedDB: new IDBFactory(), dbName: "clear-plan" });
    await store.put(buildPlan("clear"), {
      runId: "run_clear",
      tabId: 1,
      documentId: "document_clear",
      mode: "visible-area",
    });

    await store.clear(1);

    expect(await store.get(1)).toBeNull();
  });
});
