import { convertCaptureToPortableRenderPlan } from "../core/conversion/convert.js";
import { renderPlanToFigmaClipboardPayload } from "../core/conversion/clipboard-svg.js";
import { BackgroundController, type BackgroundPlatform } from "./background-controller.js";
import { MAX_ASSET_BYTES } from "./content-assets.js";
import { RenderPlanStore } from "./plan-store.js";
import { isPopupMessage, type ContentMessage, type PopupResponse } from "./types.js";
import type { ExtensionState } from "./state-machine.js";

const RESULT_EXPIRY_ALARM = "web2ui-local-result-expiry";
const EXTENSION_STATES_KEY = "extensionStates";
const LEGACY_EXTENSION_STATE_KEY = "extensionState";
const store = new RenderPlanStore();
const platform: BackgroundPlatform = {
  now: Date.now,
  nextRunId: () => `run_${crypto.randomUUID().replaceAll("-", "")}`,
  getActiveTab: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url) throw new Error("No active page");
    return { id: tab.id, url: tab.url };
  },
  measureViewport: async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => ({
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight),
        deviceScaleFactor: Math.max(0.1, window.devicePixelRatio || 1),
      }),
    });
    if (!result?.result) throw new Error("Could not measure the active page");
    return result.result;
  },
  getCurrentDocumentId: async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => undefined,
    });
    return results.find((result) => result.frameId === 0)?.documentId ?? null;
  },
  attachDebugger: async (tabId) => {
    await chrome.debugger.attach({ tabId }, "1.3");
  },
  sendDebuggerCommand: async (tabId, method, parameters) =>
    chrome.debugger.sendCommand({ tabId }, method, parameters),
  detachDebugger: async (tabId) => {
    await chrome.debugger.detach({ tabId });
  },
  injectContent: async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["content.js"],
    });
    const topFrame = results.find((result) => result.frameId === 0);
    if (!topFrame?.documentId) throw new Error("Could not identify the active document");
    return { documentId: topFrame.documentId };
  },
  sendCaptureCommand: async (tabId, documentId, command) => {
    await chrome.tabs.sendMessage(tabId, command, { documentId });
  },
  loadStates: async () => {
    const stored = await chrome.storage.local.get([
      EXTENSION_STATES_KEY,
      LEGACY_EXTENSION_STATE_KEY,
    ]);
    if (stored[EXTENSION_STATES_KEY] !== undefined) return stored[EXTENSION_STATES_KEY];
    const legacy = stored[LEGACY_EXTENSION_STATE_KEY] as ExtensionState | undefined;
    return typeof legacy === "object" && legacy !== null && "tabId" in legacy
      ? { [String(legacy.tabId)]: legacy }
      : {};
  },
  saveStates: async (states) => {
    await chrome.storage.local.set({ [EXTENSION_STATES_KEY]: states });
    await chrome.storage.local.remove(LEGACY_EXTENSION_STATE_KEY);
  },
  scheduleResultExpiry: async (when) => {
    await chrome.alarms.create(RESULT_EXPIRY_ALARM, { when });
  },
  clearResultExpiry: async () => {
    await chrome.alarms.clear(RESULT_EXPIRY_ALARM);
  },
};

const controller = new BackgroundController({
  platform,
  store,
  convert: convertCaptureToPortableRenderPlan,
  clipboard: renderPlanToFigmaClipboardPayload,
});
const initialization = controller.initialize().catch(() => undefined);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isContentMessage(message)) {
    if (sender.tab?.id === undefined || sender.documentId === undefined) return undefined;
    const senderIdentity = { tabId: sender.tab.id, documentId: sender.documentId };
    void initialization
      .then(async () => {
        if (!controller.acceptsContentIdentity(message, senderIdentity)) {
          return { ok: false, code: "stale-capture" };
        }
        if (message.type === "fetch-asset") return fetchDeclaredAsset(message.url);
        if (message.type === "capture-element-screenshot") {
          return captureElementScreenshot(message.tabId, message.rect);
        }
        await controller.handleContentMessage(message, senderIdentity);
        return { ok: true };
      })
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "local-operation-failed" }));
    return true;
  }

  if (sender.id !== chrome.runtime.id || !isPopupMessage(message)) return undefined;
  void initialization
    .then(async (): Promise<PopupResponse> => {
      switch (message.type) {
        case "get-state": {
          const tab = await platform.getActiveTab();
          return { ok: true, state: controller.getState(tab.id) };
        }
        case "get-active-tab-viewport": {
          try {
            const tab = await platform.getActiveTab();
            const viewport = await platform.measureViewport(tab.id);
            return {
              ok: true,
              viewport: {
                widthPx: viewport.width,
                heightPx: viewport.height,
                deviceScaleFactor: viewport.deviceScaleFactor,
              },
            };
          } catch {
            return { ok: true, viewport: null };
          }
        }
        case "start-capture": {
          const state = await controller.startCapture(
            message.mode,
            message.options ?? {
              viewports: [{ id: "browser", label: "Browser", widthPx: null, source: "browser" }],
              themes: [{ id: "browser", label: "Browser", source: "browser" }],
            },
          );
          return { ok: true, state };
        }
        case "prepare-clipboard":
          return { ok: true, payload: await controller.prepareClipboard(message.tabId) };
        case "clear-result": {
          await controller.clear(message.tabId);
          return { ok: true };
        }
      }
    })
    .then(sendResponse)
    .catch(async (error: unknown) => {
      const tab = await platform.getActiveTab().catch(() => null);
      const state = controller.getState(tab?.id);
      const code =
        error instanceof Error && error.message === "Unsupported page"
          ? "unsupported-page"
          : state.status === "error"
            ? state.code
            : "local-operation-failed";
      sendResponse({
        ok: false,
        code,
      });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    void initialization.then(() => controller.handlePageChange(tabId));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void initialization.then(() => controller.removeTab(tabId));
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined && controller.hasActiveSession(source.tabId)) {
    void controller.failForPageChange(source.tabId, false);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RESULT_EXPIRY_ALARM) return;
  void initialization.then(() => controller.handleResultExpiry()).catch(() => undefined);
});

async function fetchDeclaredAsset(url: string): Promise<{
  ok: boolean;
  bytes?: ArrayBuffer;
  contentType?: string;
}> {
  if (!isHttpUrl(url)) return { ok: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false };
    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) return { ok: false };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ASSET_BYTES) return { ok: false };
    return {
      ok: true,
      bytes,
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function captureElementScreenshot(
  tabId: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ ok: boolean; dataUrl?: string }> {
  if (!isSafeScreenshotRect(rect)) return { ok: false };
  try {
    const result = (await platform.sendDebuggerCommand(tabId, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { ...rect, scale: 1 },
    })) as { data?: unknown };
    if (typeof result.data !== "string") return { ok: false };
    if (result.data.length > Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 8) return { ok: false };
    return { ok: true, dataUrl: `data:image/png;base64,${result.data}` };
  } catch {
    return { ok: false };
  }
}

function isContentMessage(value: unknown): value is ContentMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.runId !== "string" ||
    !Number.isInteger(candidate.tabId) ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.type !== "string"
  ) {
    return false;
  }
  switch (candidate.type) {
    case "capture-progress":
      return typeof candidate.progress === "number" && typeof candidate.label === "string";
    case "capture-done":
      return typeof candidate.document === "object" && candidate.document !== null;
    case "capture-error":
      return typeof candidate.code === "string";
    case "capture-element-screenshot":
      return isSafeScreenshotRect(candidate.rect);
    case "fetch-asset":
      return typeof candidate.url === "string";
    default:
      return false;
  }
}

function isSafeScreenshotRect(value: unknown): value is {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every(isFiniteNumber)) return false;
  const width = Number(rect.width);
  const height = Number(rect.height);
  return width >= 1 && height >= 1 && width <= 16_384 && height <= 16_384 && width * height <= 32_000_000;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export {};
