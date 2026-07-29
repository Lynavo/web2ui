import { describe, expect, it, vi } from "vitest";
import { CAPTURE_CONTRACT_VERSION, type CaptureDocument } from "../src/core/contracts/capture.js";
import { RENDER_PLAN_CONTRACT_VERSION, type RenderPlan } from "../src/core/contracts/render-plan.js";
import {
  BackgroundController,
  DEFAULT_CAPTURE_OPTIONS,
  countVisualWarningDetails,
  type BackgroundPlatform,
  type LocalPlanStore,
} from "../src/extension/background-controller.js";
import {
  RenderPlanTooLargeError,
  type StoredRenderPlan,
} from "../src/extension/plan-store.js";

function capture(): CaptureDocument {
  return {
    schemaVersion: CAPTURE_CONTRACT_VERSION,
    captureId: "cap_test",
    sourceType: "chrome_capture",
    capturedAt: "2026-07-13T00:00:00.000Z",
    safeSourceLabel: "fixture.invalid",
    viewport: { widthPx: 1280, heightPx: 720, deviceScaleFactor: 1 },
    page: { widthPx: 1280, heightPx: 720, fullPage: false },
    pageBackground: { r: 1, g: 1, b: 1, a: 1 },
    root: {
      id: "n_root",
      type: "element",
      tag: "body",
      name: "body",
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      opacity: 1,
      clipsContent: true,
      fills: [],
      children: [],
    },
    assets: [],
    fonts: [],
    warnings: [],
    stats: {
      nodeCount: 1,
      textNodeCount: 0,
      imageNodeCount: 0,
      assetByteTotal: 0,
      captureDurationMs: 10,
    },
  };
}

function plan(id = "test"): RenderPlan {
  return {
    schemaVersion: RENDER_PLAN_CONTRACT_VERSION,
    renderPlanId: `rp_${id}`,
    sourceCaptureId: "cap_test",
    sourceType: "chrome_capture",
    createdAt: "2026-07-13T00:00:01.000Z",
    safeSourceLabel: "fixture.invalid",
    page: { widthPx: 1280, heightPx: 720, background: { r: 1, g: 1, b: 1, a: 1 } },
    root: {
      id: "rp_root",
      type: "FRAME",
      name: "fixture.invalid",
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
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
    stats: { nodeCount: 1, textNodeCount: 0, assetCount: 0, conversionDurationMs: 1 },
  };
}

class MemoryPlanStore implements LocalPlanStore {
  current: StoredRenderPlan | null = null;
  records = new Map<number, StoredRenderPlan>();
  clear = vi.fn(async (tabId?: number) => {
    if (Number.isInteger(tabId)) {
      const resolvedTabId = tabId as number;
      this.records.delete(resolvedTabId);
      if (this.current?.tabId === resolvedTabId) this.current = null;
      return;
    }
    this.records.clear();
    this.current = null;
  });
  get = vi.fn(async (tabId: number) => this.records.get(tabId) ?? (this.current?.tabId === tabId ? this.current : null));
  getAll = vi.fn(async () => {
    const values = [...this.records.values()];
    if (this.current && !values.some((record) => record.tabId === this.current?.tabId)) values.push(this.current);
    return values;
  });
  put = vi.fn(
    async (
      value: RenderPlan,
      identity: { runId: string; tabId: number; documentId: string; mode: "visible-area" | "full-page" },
    ) => {
      this.current = {
        id: `tab:${identity.tabId}`,
        ...identity,
        createdAt: 1_000,
        expiresAt: 1_000 + 24 * 60 * 60 * 1_000,
        plan: value,
      };
      this.records.set(identity.tabId, this.current);
      return this.current;
    },
  );
  cleanupExpired = vi.fn(async () => undefined);
}

function platform(overrides: Partial<BackgroundPlatform> = {}): BackgroundPlatform {
  return {
    now: () => 1_000,
    nextRunId: () => "run_current",
    getActiveTab: vi.fn(async () => ({ id: 7, url: "https://fixture.invalid/page" })),
    measureViewport: vi.fn(async () => ({ width: 1280, height: 720, deviceScaleFactor: 1 })),
    getCurrentDocumentId: vi.fn(async () => "document_current"),
    attachDebugger: vi.fn(async () => undefined),
    sendDebuggerCommand: vi.fn(async () => ({})),
    detachDebugger: vi.fn(async () => undefined),
    injectContent: vi.fn(async () => ({ documentId: "document_current" })),
    sendCaptureCommand: vi.fn(async () => undefined),
    loadStates: vi.fn(async () => ({})),
    saveStates: vi.fn(async () => undefined),
    scheduleResultExpiry: vi.fn(async () => undefined),
    clearResultExpiry: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("BackgroundController", () => {
  it("counts unique affected nodes while preserving unscoped warning totals", () => {
    expect(
      countVisualWarningDetails([
        { code: "canvas_rasterized", nodeId: "n_canvas", count: 1 },
        { code: "dynamic_frame_unavailable", nodeId: "n_canvas", count: 1 },
        { code: "asset_fetch_failed", nodeId: "n_image", count: 1 },
        { code: "font_not_loaded", count: 2 },
      ]),
    ).toBe(4);
  });

  it("starts only a local Visible Area capture on the active HTTP(S) tab", async () => {
    const target = platform();
    const store = new MemoryPlanStore();
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);

    expect(controller.getState()).toMatchObject({
      status: "capturing",
      runId: "run_current",
      tabId: 7,
      documentId: "document_current",
      mode: "visible-area",
    });
    expect(store.clear).toHaveBeenCalledOnce();
    expect(target.attachDebugger).toHaveBeenCalledWith(7);
    expect(target.sendCaptureCommand).toHaveBeenCalledWith(
      7,
      "document_current",
      expect.objectContaining({ type: "run-capture", mode: "visible-area" }),
    );
  });

  it("clears all emulation and detaches debugger after local conversion succeeds", async () => {
    const target = platform();
    const store = new MemoryPlanStore();
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan("converted"),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });
    await controller.startCapture("full-page", {
      viewports: [{ id: "desktop", label: "Desktop", widthPx: 1440, source: "preset" }],
      themes: [{ id: "dark", label: "Dark", source: "forced" }],
    });

    await controller.handleContentMessage(
      {
        type: "capture-done",
        runId: "run_current",
        tabId: 7,
        documentId: "document_current",
        document: capture(),
      },
      { tabId: 7, documentId: "document_current" },
    );

    expect(controller.getState().status).toBe("ready");
    expect(store.put).toHaveBeenCalledOnce();
    expect(target.sendDebuggerCommand).toHaveBeenCalledWith(
      7,
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({ width: 1440, height: 720 }),
    );
    expect(target.sendDebuggerCommand).toHaveBeenCalledWith(
      7,
      "Emulation.clearDeviceMetricsOverride",
      {},
    );
    expect(target.sendDebuggerCommand).toHaveBeenCalledWith(
      7,
      "Emulation.setEmulatedMedia",
      { features: [] },
    );
    expect(target.detachDebugger).toHaveBeenCalledWith(7);
  });

  it("ignores stale content identities without changing current state", async () => {
    const controller = new BackgroundController({
      platform: platform(),
      store: new MemoryPlanStore(),
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });
    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    const before = controller.getState();

    await controller.handleContentMessage(
      {
        type: "capture-done",
        runId: "run_stale",
        tabId: 7,
        documentId: "document_current",
        document: capture(),
      },
      { tabId: 7, documentId: "document_current" },
    );

    expect(controller.getState()).toBe(before);
  });

  it("restores a non-expired ready plan after service-worker restart", async () => {
    const store = new MemoryPlanStore();
    store.current = {
      id: "current",
      runId: "run_saved",
      tabId: 3,
      documentId: "document_saved",
      mode: "visible-area",
      createdAt: 1_000,
      expiresAt: 1_000 + 24 * 60 * 60 * 1_000,
      plan: plan("saved"),
    };
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.initialize();

    expect(controller.getState()).toMatchObject({
      status: "ready",
      runId: "run_saved",
      documentId: "document_saved",
    });
  });

  it("restores an active capture identity after service-worker restart", async () => {
    const target = platform({
      loadStates: vi.fn(async () => ({
        "7": {
          status: "capturing",
          runId: "run_saved",
          tabId: 7,
          documentId: "document_saved",
          mode: "visible-area",
          startedAt: 1_000,
          progress: 0.35,
          label: "Reading the page",
        },
      })),
    });
    const controller = new BackgroundController({
      platform: target,
      store: new MemoryPlanStore(),
      convert: () => plan("saved"),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.initialize();
    await controller.handleContentMessage(
      {
        type: "capture-progress",
        runId: "run_saved",
        tabId: 7,
        documentId: "document_saved",
        progress: 0.7,
        label: "Reading styles",
      },
      { tabId: 7, documentId: "document_saved" },
    );

    expect(controller.getState(7)).toMatchObject({
      status: "capturing",
      runId: "run_saved",
      progress: 0.7,
      label: "Reading styles",
    });
  });

  it("keeps the ready plan retryable when async clipboard preparation fails", async () => {
    const store = new MemoryPlanStore();
    store.current = {
      id: "current",
      runId: "run_saved",
      tabId: 3,
      documentId: "document_saved",
      mode: "visible-area",
      createdAt: 1_000,
      expiresAt: 1_000 + 24 * 60 * 60 * 1_000,
      plan: plan("saved"),
    };
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: async () => {
        throw new Error("clipboard conversion failed");
      },
    });
    await controller.initialize();

    await expect(controller.prepareClipboard()).rejects.toThrow("clipboard conversion failed");

    expect(controller.getState()).toMatchObject({
      status: "ready",
      copyResult: "failed",
    });
    expect(store.current?.plan.renderPlanId).toBe("rp_saved");
  });

  it("does not detach a debugger session when attach permission was never granted", async () => {
    const attachError = new Error("permission denied");
    const target = platform({
      attachDebugger: vi.fn(async () => {
        throw attachError;
      }),
    });
    const controller = new BackgroundController({
      platform: target,
      store: new MemoryPlanStore(),
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await expect(
      controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS),
    ).rejects.toBe(attachError);

    expect(controller.getState()).toMatchObject({ status: "error", code: "permission-denied" });
    expect(target.detachDebugger).not.toHaveBeenCalled();
  });

  it("reports a conversion exception without claiming the page is too complex", async () => {
    const controller = new BackgroundController({
      platform: platform(),
      store: new MemoryPlanStore(),
      convert: () => {
        throw new Error("unsupported capture structure");
      },
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await completeCapture(controller);

    expect(controller.getState()).toEqual({
      status: "error",
      code: "conversion-failed",
      message: "A page structure could not be converted locally.",
    });
  });

  it("reports local storage failures separately from conversion failures", async () => {
    const store = new MemoryPlanStore();
    store.put.mockRejectedValueOnce(new Error("IndexedDB transaction aborted"));
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await completeCapture(controller);

    expect(controller.getState()).toEqual({
      status: "error",
      code: "storage-failed",
      message: "Chrome could not save the converted result locally.",
    });
  });

  it("reports the measured result size when it exceeds the local limit", async () => {
    const store = new MemoryPlanStore();
    store.put.mockRejectedValueOnce(
      new RenderPlanTooLargeError(28 * 1024 * 1024, 25 * 1024 * 1024),
    );
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await completeCapture(controller);

    expect(controller.getState()).toEqual({
      status: "error",
      code: "plan-too-large",
      message: "The converted result is 28.0 MB, above the 25.0 MB local limit.",
    });
  });

  it("keeps capture runs and progress isolated by source tab", async () => {
    let activeTabId = 7;
    let runSequence = 0;
    const target = platform({
      getActiveTab: vi.fn(async () => ({
        id: activeTabId,
        url: `https://fixture.invalid/tab-${activeTabId}`,
      })),
      nextRunId: () => `run_${++runSequence}`,
      injectContent: vi.fn(async (tabId) => ({ documentId: `document_${tabId}` })),
    });
    const controller = new BackgroundController({
      platform: target,
      store: new MemoryPlanStore(),
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    activeTabId = 8;
    await controller.startCapture("full-page", DEFAULT_CAPTURE_OPTIONS);

    await controller.handleContentMessage(
      {
        type: "capture-progress",
        runId: "run_1",
        tabId: 7,
        documentId: "document_7",
        progress: 0.42,
        label: "Reading tab A",
      },
      { tabId: 7, documentId: "document_7" },
    );

    expect(controller.getState(7)).toMatchObject({
      status: "capturing",
      progress: 0.42,
      label: "Reading tab A",
    });
    expect(controller.getState(8)).toMatchObject({
      status: "capturing",
      runId: "run_2",
      mode: "full-page",
    });
    expect(controller.getState(9)).toEqual({ status: "idle" });
  });

  it("does not replace another tab's ready result with a protected-page error", async () => {
    let activeTab = { id: 7, url: "https://fixture.invalid/source" };
    const store = new MemoryPlanStore();
    const target = platform({
      getActiveTab: vi.fn(async () => activeTab),
    });
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan("source"),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await completeCapture(controller);
    activeTab = { id: 10, url: "chrome://settings" };
    await expect(
      controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS),
    ).rejects.toThrow("Unsupported page");

    expect(controller.getState(7).status).toBe("ready");
    expect(controller.getState(10)).toMatchObject({
      status: "error",
      code: "unsupported-page",
    });
    expect(store.current?.runId).toBe("run_current");
  });

  it("keeps A, B, and C independent while a protected D tab is opened", async () => {
    let activeTabId = 1;
    let runSequence = 0;
    const store = new MemoryPlanStore();
    const target = platform({
      getActiveTab: vi.fn(async () => ({
        id: activeTabId,
        url: activeTabId === 4 ? "chrome://settings" : `https://fixture.invalid/tab-${activeTabId}`,
      })),
      nextRunId: () => `run_${++runSequence}`,
      injectContent: vi.fn(async (tabId) => ({ documentId: `document_${tabId}` })),
    });
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    activeTabId = 2;
    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    activeTabId = 3;
    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);

    for (const tabId of [1, 2]) {
      await controller.handleContentMessage(
        {
          type: "capture-progress",
          runId: `run_${tabId}`,
          tabId,
          documentId: `document_${tabId}`,
          progress: 0.5,
          label: `Reading tab ${tabId}`,
        },
        { tabId, documentId: `document_${tabId}` },
      );
    }
    await finishTab(controller, 3, "run_3");

    activeTabId = 4;
    await expect(controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS)).rejects.toThrow(
      "Unsupported page",
    );

    expect(controller.getState(1)).toMatchObject({ status: "capturing", progress: 0.5 });
    expect(controller.getState(2)).toMatchObject({ status: "capturing", progress: 0.5 });
    expect(controller.getState(3)).toMatchObject({ status: "ready", runId: "run_3" });
    expect(controller.getState(4)).toMatchObject({ status: "error", code: "unsupported-page" });
    expect(store.records.get(3)?.runId).toBe("run_3");
  });

  it("keeps completed results isolated when a later tab completes", async () => {
    let activeTabId = 7;
    let runSequence = 0;
    const store = new MemoryPlanStore();
    const target = platform({
      getActiveTab: vi.fn(async () => ({
        id: activeTabId,
        url: `https://fixture.invalid/tab-${activeTabId}`,
      })),
      nextRunId: () => `run_${++runSequence}`,
      injectContent: vi.fn(async (tabId) => ({ documentId: `document_${tabId}` })),
    });
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan(`tab-${activeTabId}`),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    activeTabId = 8;
    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    await finishTab(controller, 7, "run_1");
    expect(controller.getState(7).status).toBe("ready");

    await finishTab(controller, 8, "run_2");

    expect(controller.getState(7).status).toBe("ready");
    expect(controller.getState(8).status).toBe("ready");
    expect(store.records.get(7)?.runId).toBe("run_1");
    expect(store.records.get(8)?.runId).toBe("run_2");
  });

  it("clears stale ready UI state when the stored local result expires", async () => {
    const store = new MemoryPlanStore();
    const target = platform();
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });
    await completeCapture(controller);
    expect(controller.getState(7).status).toBe("ready");

    store.records.clear();
    store.current = null;
    await controller.handleResultExpiry();

    expect(controller.getState(7)).toEqual({ status: "idle" });
    expect(target.clearResultExpiry).toHaveBeenCalled();
  });

  it("clears ready data only when its source tab navigates", async () => {
    const store = new MemoryPlanStore();
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });
    await completeCapture(controller);

    await controller.handlePageChange(8);
    expect(controller.getState(7).status).toBe("ready");
    expect(store.current?.tabId).toBe(7);

    await controller.handlePageChange(7);
    expect(controller.getState(7)).toEqual({ status: "idle" });
    expect(store.current).toBeNull();
  });

  it("clears ready data only when its source tab closes", async () => {
    const store = new MemoryPlanStore();
    const controller = new BackgroundController({
      platform: platform(),
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });
    await completeCapture(controller);

    await controller.removeTab(8);
    expect(controller.getState(7).status).toBe("ready");
    expect(store.current?.tabId).toBe(7);

    await controller.removeTab(7);
    expect(controller.getState(7)).toEqual({ status: "idle" });
    expect(store.current).toBeNull();
  });

  it("fails only the capture whose document changed", async () => {
    let activeTabId = 7;
    let runSequence = 0;
    const target = platform({
      getActiveTab: vi.fn(async () => ({
        id: activeTabId,
        url: `https://fixture.invalid/tab-${activeTabId}`,
      })),
      nextRunId: () => `run_${++runSequence}`,
      injectContent: vi.fn(async (tabId) => ({ documentId: `document_${tabId}` })),
      getCurrentDocumentId: vi.fn(async (tabId) =>
        tabId === 7 ? "document_replaced" : `document_${tabId}`,
      ),
    });
    const controller = new BackgroundController({
      platform: target,
      store: new MemoryPlanStore(),
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    activeTabId = 8;
    await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    await controller.handlePageChange(7);

    expect(controller.getState(7)).toMatchObject({ status: "error", code: "page-changed" });
    expect(controller.getState(8)).toMatchObject({ status: "capturing", runId: "run_2" });
    expect(controller.hasActiveSession(7)).toBe(false);
    expect(controller.hasActiveSession(8)).toBe(true);
  });

  it("keeps capture state isolated across twenty tabs and retains one final result", async () => {
    let activeTabId = 1;
    const store = new MemoryPlanStore();
    const target = platform({
      getActiveTab: vi.fn(async () => ({
        id: activeTabId,
        url: `https://fixture.invalid/tab-${activeTabId}`,
      })),
      nextRunId: () => `run_${activeTabId}`,
      injectContent: vi.fn(async (tabId) => ({ documentId: `document_${tabId}` })),
    });
    const controller = new BackgroundController({
      platform: target,
      store,
      convert: () => plan(),
      clipboard: () => ({ svg: "<svg/>", html: "<svg/>", text: "<svg/>" }),
    });

    for (activeTabId = 1; activeTabId <= 20; activeTabId += 1) {
      await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
    }
    for (let tabId = 1; tabId <= 20; tabId += 1) {
      await controller.handleContentMessage(
        {
          type: "capture-progress",
          runId: `run_${tabId}`,
          tabId,
          documentId: `document_${tabId}`,
          progress: tabId / 20,
          label: `Reading tab ${tabId}`,
        },
        { tabId, documentId: `document_${tabId}` },
      );
    }
    for (let tabId = 1; tabId <= 20; tabId += 1) {
      await finishTab(controller, tabId, `run_${tabId}`);
    }

    for (let tabId = 1; tabId <= 20; tabId += 1) {
      expect(controller.getState(tabId)).toMatchObject({ status: "ready", runId: `run_${tabId}` });
    }
    expect(store.records.size).toBe(20);
  });
});

async function completeCapture(controller: BackgroundController): Promise<void> {
  await controller.startCapture("visible-area", DEFAULT_CAPTURE_OPTIONS);
  await controller.handleContentMessage(
    {
      type: "capture-done",
      runId: "run_current",
      tabId: 7,
      documentId: "document_current",
      document: capture(),
    },
    { tabId: 7, documentId: "document_current" },
  );
}

async function finishTab(
  controller: BackgroundController,
  tabId: number,
  runId: string,
): Promise<void> {
  await controller.handleContentMessage(
    {
      type: "capture-done",
      runId,
      tabId,
      documentId: `document_${tabId}`,
      document: capture(),
    },
    { tabId, documentId: `document_${tabId}` },
  );
}
