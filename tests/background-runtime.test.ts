import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_CONTRACT_VERSION, type CaptureDocument } from "../src/core/contracts/capture.js";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

function chromeHarness() {
  const runtimeListeners: RuntimeListener[] = [];
  const tabUpdatedListeners: Array<(...arguments_: unknown[]) => void> = [];
  const tabRemovedListeners: Array<(...arguments_: unknown[]) => void> = [];
  const debuggerDetachListeners: Array<(...arguments_: unknown[]) => void> = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
  const addRuntimeListener = vi.fn((listener: RuntimeListener) => runtimeListeners.push(listener));
  const localStorage: Record<string, unknown> = {};
  let activeTab = { id: 7, url: "https://fixture.invalid/page" };

  const chromeMock = {
    runtime: {
      id: "extension-id",
      onMessage: { addListener: addRuntimeListener },
    },
    tabs: {
      query: vi.fn(async () => [{ ...activeTab }]),
      sendMessage: vi.fn(
        async (tabId: number, message: unknown, options?: { documentId?: string }) => {
          void tabId;
          void message;
          void options;
        },
      ),
      onUpdated: { addListener: vi.fn((listener) => tabUpdatedListeners.push(listener)) },
      onRemoved: { addListener: vi.fn((listener) => tabRemovedListeners.push(listener)) },
    },
    scripting: {
      executeScript: vi.fn(async (details: { files?: string[] }) =>
        details.files
          ? [{ frameId: 0, documentId: "document_current" }]
          : [
              {
                frameId: 0,
                documentId: "document_measure",
                result: { width: 1280, height: 720, deviceScaleFactor: 1 },
              },
            ],
      ),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      detach: vi.fn(async () => undefined),
      onDetach: { addListener: vi.fn((listener) => debuggerDetachListeners.push(listener)) },
    },
    alarms: {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn((listener) => alarmListeners.push(listener)) },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return structuredClone(localStorage);
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => key in localStorage)
              .map((key) => [key, structuredClone(localStorage[key])]),
          );
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(localStorage, structuredClone(values));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localStorage[key];
        }),
      },
    },
  };

  return {
    chromeMock,
    runtimeListeners,
    addRuntimeListener,
    tabUpdatedListeners,
    tabRemovedListeners,
    debuggerDetachListeners,
    alarmListeners,
    localStorage,
    setActiveTab: (id: number, url = `https://fixture.invalid/tab-${id}`) => {
      activeTab = { id, url };
    },
  };
}

function captureDocument(): CaptureDocument {
  return {
    schemaVersion: CAPTURE_CONTRACT_VERSION,
    captureId: "cap_runtime",
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
      captureDurationMs: 1,
    },
  };
}

describe("background runtime", () => {
  it("installs one runtime boundary and serves local state to the popup", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());

    await import("../src/extension/background.js");

    expect(harness.addRuntimeListener).toHaveBeenCalledOnce();
    expect(harness.runtimeListeners).toHaveLength(1);
    const sendResponse = vi.fn();
    const keepChannelOpen = harness.runtimeListeners[0]?.(
      { type: "get-state" },
      { id: "extension-id" },
      sendResponse,
    );
    expect(keepChannelOpen).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, state: { status: "idle" } });
    });
  });

  it("serves a packaged popup opened in an extension tab without treating it as content", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());

    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const sendResponse = vi.fn();
    const keepChannelOpen = listener(
      { type: "get-state" },
      { id: "extension-id", tab: { id: 99 } as chrome.tabs.Tab },
      sendResponse,
    );

    expect(keepChannelOpen).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, state: { status: "idle" } });
    });
  });

  it("measures the active tab viewport for the packaged popup", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());

    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const response = vi.fn();
    expect(
      listener(
        { type: "get-active-tab-viewport" },
        { id: "extension-id" },
        response,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({
        ok: true,
        viewport: { widthPx: 1280, heightPx: 720, deviceScaleFactor: 1 },
      });
    });
  });

  it("returns a null viewport when the active page cannot be measured", async () => {
    const harness = chromeHarness();
    harness.chromeMock.scripting.executeScript.mockRejectedValueOnce(new Error("blocked page"));
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const response = vi.fn();
    expect(
      listener(
        { type: "get-active-tab-viewport" },
        { id: "extension-id" },
        response,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({ ok: true, viewport: null });
    });
  });

  it("runs capture and conversion locally without making a developer-service request", async () => {
    const harness = chromeHarness();
    const fetchSpy = vi.fn();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("fetch", fetchSpy);
    await import("../src/extension/background.js");
    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");

    const startResponse = vi.fn();
    expect(
      listener(
        { type: "start-capture", mode: "visible-area" },
        { id: "extension-id" },
        startResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(startResponse).toHaveBeenCalledWith({
        ok: true,
        state: expect.objectContaining({ status: "capturing", mode: "visible-area" }),
      });
    });
    const command = harness.chromeMock.tabs.sendMessage.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    if (!command) throw new Error("capture command missing");
    expect(command).toMatchObject({
      type: "run-capture",
      tabId: 7,
      documentId: "document_current",
    });

    const doneResponse = vi.fn();
    listener(
      { ...command, type: "capture-done", document: captureDocument() },
      {
        id: "extension-id",
        tab: { id: 7 } as chrome.tabs.Tab,
        documentId: "document_current",
      },
      doneResponse,
    );
    await vi.waitFor(() => {
      expect(doneResponse).toHaveBeenCalledWith({ ok: true });
      expect(harness.chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
    });

    const stateResponse = vi.fn();
    listener({ type: "get-state" }, { id: "extension-id" }, stateResponse);
    await vi.waitFor(() => {
      expect(stateResponse).toHaveBeenCalledWith({
        ok: true,
        state: expect.objectContaining({ status: "ready", runId: command.runId }),
      });
    });
    const readyResponse = stateResponse.mock.calls[0]?.[0] as {
      state?: { status?: string; expiresAt?: number };
    };
    const expiresAt = readyResponse.state?.expiresAt;
    expect(expiresAt).toEqual(expect.any(Number));
    expect(harness.chromeMock.alarms.create).toHaveBeenCalledWith(
      "web2ui-local-result-expiry",
      { when: expiresAt },
    );

    nowSpy.mockReturnValue(expiresAt!);
    harness.alarmListeners[0]?.({ name: "web2ui-local-result-expiry", scheduledTime: expiresAt! });
    const expiredStateResponse = vi.fn();
    await vi.waitFor(() => {
      listener({ type: "get-state" }, { id: "extension-id" }, expiredStateResponse);
      expect(expiredStateResponse).toHaveBeenCalledWith({
        ok: true,
        state: { status: "idle" },
      });
    });
    expect(harness.chromeMock.alarms.clear).toHaveBeenCalledWith(
      "web2ui-local-result-expiry",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distinguishes same-document history updates from a replaced capture document", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const startResponse = vi.fn();
    listener(
      { type: "start-capture", mode: "full-page" },
      { id: "extension-id" },
      startResponse,
    );
    await vi.waitFor(() => {
      expect(startResponse).toHaveBeenCalledWith({
        ok: true,
        state: expect.objectContaining({
          status: "capturing",
          documentId: "document_current",
        }),
      });
    });

    harness.chromeMock.scripting.executeScript.mockResolvedValueOnce([
      { frameId: 0, documentId: "document_current" },
    ]);
    harness.tabUpdatedListeners[0]?.(7, {
      status: "loading",
      url: "https://fixture.invalid/page#section",
    });
    await vi.waitFor(() => {
      expect(harness.chromeMock.scripting.executeScript).toHaveBeenCalledTimes(3);
    });

    const sameDocumentResponse = vi.fn();
    listener({ type: "get-state" }, { id: "extension-id" }, sameDocumentResponse);
    await vi.waitFor(() => {
      expect(sameDocumentResponse).toHaveBeenCalledWith({
        ok: true,
        state: expect.objectContaining({
          status: "capturing",
          documentId: "document_current",
        }),
      });
    });

    harness.chromeMock.scripting.executeScript.mockResolvedValueOnce([
      { frameId: 0, documentId: "document_replaced" },
    ]);
    harness.tabUpdatedListeners[0]?.(7, { status: "loading" });

    const replacedDocumentResponse = vi.fn();
    await vi.waitFor(() => {
      listener({ type: "get-state" }, { id: "extension-id" }, replacedDocumentResponse);
      expect(replacedDocumentResponse).toHaveBeenCalledWith({
        ok: true,
        state: {
          status: "error",
          code: "page-changed",
          message: "The page changed during capture.",
        },
      });
    });
  });

  it("shows the active tab's own state while other capture runs continue", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const startA = vi.fn();
    listener({ type: "start-capture", mode: "visible-area" }, { id: "extension-id" }, startA);
    await vi.waitFor(() => expect(startA).toHaveBeenCalledWith({
      ok: true,
      state: expect.objectContaining({ status: "capturing", tabId: 7 }),
    }));
    const commandA = harness.chromeMock.tabs.sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;

    harness.setActiveTab(8);
    const idleB = vi.fn();
    listener({ type: "get-state" }, { id: "extension-id" }, idleB);
    await vi.waitFor(() => expect(idleB).toHaveBeenCalledWith({
      ok: true,
      state: { status: "idle" },
    }));

    const startB = vi.fn();
    listener({ type: "start-capture", mode: "full-page" }, { id: "extension-id" }, startB);
    await vi.waitFor(() => expect(startB).toHaveBeenCalledWith({
      ok: true,
      state: expect.objectContaining({ status: "capturing", tabId: 8 }),
    }));

    const progressA = vi.fn();
    listener(
      { ...commandA, type: "capture-progress", progress: 0.42, label: "Reading tab A" },
      { id: "extension-id", tab: { id: 7 } as chrome.tabs.Tab, documentId: "document_current" },
      progressA,
    );
    await vi.waitFor(() => expect(progressA).toHaveBeenCalledWith({ ok: true }));

    harness.setActiveTab(7);
    const stateA = vi.fn();
    listener({ type: "get-state" }, { id: "extension-id" }, stateA);
    await vi.waitFor(() => expect(stateA).toHaveBeenCalledWith({
      ok: true,
      state: expect.objectContaining({
        status: "capturing",
        tabId: 7,
        progress: 0.42,
        label: "Reading tab A",
      }),
    }));
  });

  it("keeps a successful source result when capture is attempted on a protected tab", async () => {
    const harness = chromeHarness();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await import("../src/extension/background.js");

    const listener = harness.runtimeListeners[0];
    if (!listener) throw new Error("runtime listener missing");
    const start = vi.fn();
    listener({ type: "start-capture", mode: "visible-area" }, { id: "extension-id" }, start);
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    const command = harness.chromeMock.tabs.sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    const done = vi.fn();
    listener(
      { ...command, type: "capture-done", document: captureDocument() },
      { id: "extension-id", tab: { id: 7 } as chrome.tabs.Tab, documentId: "document_current" },
      done,
    );
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ ok: true }));

    harness.setActiveTab(10, "chrome://settings");
    const blocked = vi.fn();
    listener({ type: "start-capture", mode: "visible-area" }, { id: "extension-id" }, blocked);
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledWith({
      ok: false,
      code: "unsupported-page",
    }));

    harness.setActiveTab(7);
    const sourceState = vi.fn();
    listener({ type: "get-state" }, { id: "extension-id" }, sourceState);
    await vi.waitFor(() => expect(sourceState).toHaveBeenCalledWith({
      ok: true,
      state: expect.objectContaining({ status: "ready", tabId: 7 }),
    }));
  });
});
