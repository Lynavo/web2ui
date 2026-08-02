import {
  cleanupCaptureMarkersInPage,
  extractCaptureInPage,
  type InPageAssetRequest,
  type InPageExtractionResult,
} from "../core/capture/in-page-extractor.js";
import {
  hideConsentOverlaysInPage,
  restoreConsentOverlaysInPage,
} from "../core/capture/consent-overlays.js";
import {
  decodeCaptureInlineAssetData,
  type CaptureAsset,
  type CaptureWarning,
  type PageRect,
} from "../core/contracts/capture.js";
import { executeContentCapture, type ContentCaptureDependencies } from "./content-capture.js";
import {
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  buildAssetWarnings,
  collectAssetNodeIds,
  normalizeCaptureAsset,
  partitionCaptureInlineAssets,
  type CaptureAssetRasterizer,
} from "./content-assets.js";
import {
  captureAncestorScrollPositions,
  cleanupCaptureMarkers,
  findCaptureMarker,
  localStaticSettleDelayMs,
  resolveLocalStaticScreenshotFallbacks,
  restoreAncestorHorizontalScroll,
  restoreAncestorScrollPositions,
  screenshotFallbackPageClip,
  type ScreenshotFallbackNode,
} from "./content-fallbacks.js";
import {
  restorePageScroll,
  restorePageScrollToTop,
  stabilizeFullPageScroll,
} from "./content-scroll.js";
import {
  CAPTURE_MODES,
  isPopupMessage,
  type ContentMessage,
  type ElementScreenshotResponse,
  type FetchAssetResponse,
  type RunCaptureCommand,
} from "./types.js";

const CONTENT_RUNTIME_KEY = "__web2uiLocalCaptureContentV1";
const runtimeGlobal = globalThis as typeof globalThis & Record<string, unknown>;

let activeCommand: RunCaptureCommand | null = null;

if (typeof chrome !== "undefined" && runtimeGlobal[CONTENT_RUNTIME_KEY] !== true) {
  runtimeGlobal[CONTENT_RUNTIME_KEY] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRunCaptureCommand(message)) return undefined;

    activeCommand = message;
    const initialScroll = { x: window.scrollX, y: window.scrollY };
    sendResponse({ accepted: true });
    void executeContentCapture(message, createBrowserDependencies(message, initialScroll))
      .then(async (document) => {
        if (!isActive(message)) return;
        await chrome.runtime.sendMessage({
          type: "capture-done",
          runId: message.runId,
          tabId: message.tabId,
          documentId: message.documentId,
          document,
        } satisfies ContentMessage);
      })
      .catch(async () => {
        if (!isActive(message)) return;
        await chrome.runtime.sendMessage({
          type: "capture-error",
          runId: message.runId,
          tabId: message.tabId,
          documentId: message.documentId,
          code: "capture-failed",
        } satisfies ContentMessage);
      })
      .finally(() => {
        if (isActive(message)) activeCommand = null;
      });
    return undefined;
  });
}

function createBrowserDependencies(
  command: RunCaptureCommand,
  initialScroll: { x: number; y: number },
): ContentCaptureDependencies {
  return {
    now: Date.now,
    nextCaptureId: () => `cap_${crypto.randomUUID().replaceAll("-", "")}`,
    viewport: () => ({
      widthPx: Math.max(1, window.innerWidth),
      heightPx: Math.max(1, window.innerHeight),
      deviceScaleFactor: Math.max(0.1, window.devicePixelRatio || 1),
    }),
    safeSourceLabel: () => window.location.hostname || "current-page",
    hideConsent: () => hideConsentOverlaysInPage().hiddenCount,
    restoreConsent: () => {
      restoreConsentOverlaysInPage();
    },
    stabilizeFullPage,
    settlePage,
    viewportClip: () => ({
      x: initialScroll.x,
      y: initialScroll.y,
      width: window.innerWidth,
      height: window.innerHeight,
    }),
    extract: extractCaptureInPage,
    resolveAssets,
    resolveFallbacks,
    cleanupMarkers: () => {
      cleanupCaptureMarkers();
      cleanupCaptureMarkersInPage();
    },
    restoreScroll: () => restorePageScroll(initialScroll),
    assertActive: () => assertActive(command),
    reportProgress: async (_current, progress, label) => {
      await sendForRun(command, { type: "capture-progress", progress, label });
    },
  };
}

async function resolveAssets(
  extraction: InPageExtractionResult,
  command: RunCaptureCommand,
): Promise<{ assets: CaptureAsset[]; warnings: CaptureWarning[] }> {
  const assets: CaptureAsset[] = [];
  const warnings: CaptureWarning[] = [];
  const nodeIdsByAsset = collectAssetNodeIds(extraction.root);
  let totalBytes = 0;

  const addAsset = (asset: CaptureAsset): boolean => {
    if (asset.byteSize > MAX_ASSET_BYTES || totalBytes + asset.byteSize > MAX_TOTAL_ASSET_BYTES) {
      warnings.push(...buildAssetWarnings("asset_too_large", asset.assetId, nodeIdsByAsset));
      return false;
    }
    totalBytes += asset.byteSize;
    assets.push(asset);
    return true;
  };

  const addInlineAsset = async (
    inline: (typeof extraction.inlineAssets)[number],
  ): Promise<void> => {
    const sourceBytes = decodeCaptureInlineAssetData(inline.data, inline.mediaType);
    if (sourceBytes === null || sourceBytes.byteLength > MAX_ASSET_BYTES) {
      warnings.push(
        ...buildAssetWarnings(
          sourceBytes === null ? "asset_fetch_failed" : "asset_too_large",
          inline.assetId,
          nodeIdsByAsset,
        ),
      );
      return;
    }
    const asset = await normalizeCaptureAsset(
      {
        assetId: inline.assetId,
        sourceKind: inline.kind,
        bytes: sourceBytes,
        mediaType: inline.mediaType,
        ...(inline.naturalWidth === undefined ? {} : { naturalWidth: inline.naturalWidth }),
        ...(inline.naturalHeight === undefined ? {} : { naturalHeight: inline.naturalHeight }),
      },
      rasterizeCaptureAssetInBrowser,
    );
    if (asset === null) {
      warnings.push(...buildAssetWarnings("asset_fetch_failed", inline.assetId, nodeIdsByAsset));
      return;
    }
    addAsset(asset);
  };

  const inlineAssets = partitionCaptureInlineAssets(extraction.inlineAssets);
  for (const inline of inlineAssets.primary) await addInlineAsset(inline);

  const remoteResults = await mapWithConcurrency(
    extraction.assetRequests,
    6,
    async (request) => fetchRemoteAsset(request, command),
  );
  for (let index = 0; index < extraction.assetRequests.length; index += 1) {
    const request = extraction.assetRequests[index];
    const result = remoteResults[index];
    if (!request) {
      warnings.push({ code: "asset_fetch_failed", count: 1 });
      continue;
    }
    if (!result) {
      warnings.push(...buildAssetWarnings("asset_fetch_failed", request.assetId, nodeIdsByAsset));
      continue;
    }
    const asset = await normalizeCaptureAsset(
      {
        assetId: request.assetId,
        sourceKind: request.kind,
        bytes: result.bytes,
        mediaType: result.contentType,
        ...(request.tint === undefined ? {} : { tint: request.tint }),
        ...(request.naturalWidth === undefined ? {} : { naturalWidth: request.naturalWidth }),
        ...(request.naturalHeight === undefined ? {} : { naturalHeight: request.naturalHeight }),
      },
      rasterizeCaptureAssetInBrowser,
    );
    if (!asset) {
      warnings.push(...buildAssetWarnings("asset_fetch_failed", request.assetId, nodeIdsByAsset));
      continue;
    }
    addAsset(asset);
  }
  for (const inline of inlineAssets.deferred) await addInlineAsset(inline);
  return { assets, warnings };
}

async function fetchRemoteAsset(
  request: InPageAssetRequest,
  command: RunCaptureCommand,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!isHttpUrl(request.url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(request.url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("asset response failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        contentType: response.headers.get("content-type") ?? "",
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    const response = await sendForRun<FetchAssetResponse>(command, {
      type: "fetch-asset",
      url: request.url,
    });
    if (!response.ok || response.bytes === undefined) return null;
    return {
      bytes: new Uint8Array(response.bytes),
      contentType: response.contentType ?? "",
    };
  }
}

const rasterizeCaptureAssetInBrowser: CaptureAssetRasterizer = async ({
  bytes,
  mediaType,
  tint,
}) => {
  const ownedBytes = new Uint8Array(bytes);
  const objectUrl = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: mediaType }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      const timeout = setTimeout(() => reject(new Error("image decode timed out")), 5_000);
      candidate.decoding = "async";
      candidate.onload = () => {
        clearTimeout(timeout);
        resolve(candidate);
      };
      candidate.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("image decode failed"));
      };
      candidate.src = objectUrl;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (
      width < 1 ||
      height < 1 ||
      width > 8_192 ||
      height > 8_192 ||
      width * height > 16_000_000
    ) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(image, 0, 0, width, height);
    if (tint !== undefined) {
      context.globalCompositeOperation = "source-in";
      context.fillStyle = tint;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
    }
    const dataUrl = canvas.toDataURL("image/png");
    const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const byteSize = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
    return { dataUrl, byteSize, naturalWidth: width, naturalHeight: height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

async function resolveFallbacks(
  root: InPageExtractionResult["root"],
  assets: CaptureAsset[],
  warnings: CaptureWarning[],
  command: RunCaptureCommand,
): Promise<void> {
  const resolution = await resolveLocalStaticScreenshotFallbacks({
    root,
    assets,
    maxAssetBytes: MAX_ASSET_BYTES,
    maxTotalAssetBytes: MAX_TOTAL_ASSET_BYTES,
    capture: async (request) => {
      assertActive(command);
      return captureScreenshotFallback(request, command);
    },
  });
  warnings.push(...resolution.warnings);
}

async function captureScreenshotFallback(
  request: ScreenshotFallbackNode,
  command: RunCaptureCommand,
): Promise<string | null> {
  const element = findCaptureMarker(request.nodeId, document, request.kind);
  if (!(element instanceof HTMLElement)) return null;
  const ancestorScrollPositions = captureAncestorScrollPositions(element);
  try {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    // scrollIntoView may pan authored horizontal scrollers. Restore their
    // capture-time state before reading pixels, while retaining the vertical
    // positioning that made the fallback region available to Chromium.
    restoreAncestorHorizontalScroll(ancestorScrollPositions);
    await sleep(localStaticSettleDelayMs(request.tag));
    await nextAnimationFrame();
    const liveRect = element.getBoundingClientRect();
    const clip = screenshotFallbackPageClip(
      request.rect,
      { x: liveRect.left, y: liveRect.top, width: liveRect.width, height: liveRect.height },
      { x: window.scrollX, y: window.scrollY },
    );
    if (!clip) return null;

    const restoreOverlaps = request.preserveBackdrop
      ? () => undefined
      : hideOverlappingElements(element);
    const restoreBackgroundIsolation =
      request.kind === "background-host"
        ? isolateElementBackground(element)
        : () => undefined;
    try {
      return await captureElementRect(clip, command);
    } finally {
      try {
        restoreBackgroundIsolation();
      } finally {
        restoreOverlaps();
      }
    }
  } finally {
    restoreAncestorScrollPositions(ancestorScrollPositions);
  }
}

async function captureElementRect(
  rect: PageRect,
  command: RunCaptureCommand,
): Promise<string | null> {
  const response = await sendForRun<ElementScreenshotResponse>(command, {
    type: "capture-element-screenshot",
    rect,
  });
  return response.ok ? response.dataUrl ?? null : null;
}

function hideOverlappingElements(target: HTMLElement): () => void {
  const targetRect = target.getBoundingClientRect();
  const changed: Array<{ element: HTMLElement; value: string; priority: string }> = [];
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    if (element === target || element.contains(target) || target.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    const overlaps =
      rect.left < targetRect.right &&
      rect.right > targetRect.left &&
      rect.top < targetRect.bottom &&
      rect.bottom > targetRect.top;
    if (!overlaps || rect.width < 1 || rect.height < 1) continue;
    changed.push({
      element,
      value: element.style.getPropertyValue("opacity"),
      priority: element.style.getPropertyPriority("opacity"),
    });
    element.style.setProperty("opacity", "0", "important");
  }
  return () => {
    for (const { element, value, priority } of changed) {
      if (value) element.style.setProperty("opacity", value, priority);
      else element.style.removeProperty("opacity");
    }
  };
}

function isolateElementBackground(element: HTMLElement): () => void {
  const isolationAttribute = "data-web2ui-local-background-isolation";
  const token = `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const previousIsolationValue = element.getAttribute(isolationAttribute);
  const previousHostStyle = element.getAttribute("style");
  const descendants = Array.from(element.querySelectorAll<HTMLElement>("*"));
  const previousDescendantStyles = descendants.map((descendant) => ({
    descendant,
    style: descendant.getAttribute("style"),
  }));
  const style = document.createElement("style");
  style.textContent =
    `[${isolationAttribute}="${token}"]::before,` +
    `[${isolationAttribute}="${token}"]::after{visibility:hidden!important;content:none!important}`;

  element.setAttribute(isolationAttribute, token);
  element.style.setProperty("color", "transparent", "important");
  element.style.setProperty("text-shadow", "none", "important");
  element.style.setProperty("border-color", "transparent", "important");
  element.style.setProperty("border-image-source", "none", "important");
  element.style.setProperty("box-shadow", "none", "important");
  element.style.setProperty("outline", "none", "important");
  element.style.setProperty("filter", "none", "important");
  element.style.setProperty("backdrop-filter", "none", "important");
  element.style.setProperty("mix-blend-mode", "normal", "important");
  element.style.setProperty("opacity", "1", "important");
  for (const descendant of descendants) {
    descendant.style.setProperty("visibility", "hidden", "important");
  }
  const styleRoot = element.getRootNode();
  if (styleRoot instanceof ShadowRoot) styleRoot.append(style);
  else document.head.append(style);

  return () => {
    style.remove();
    if (previousHostStyle === null) element.removeAttribute("style");
    else element.setAttribute("style", previousHostStyle);
    if (previousIsolationValue === null) element.removeAttribute(isolationAttribute);
    else element.setAttribute(isolationAttribute, previousIsolationValue);
    for (const { descendant, style: previousStyle } of previousDescendantStyles) {
      if (previousStyle === null) descendant.removeAttribute("style");
      else descendant.setAttribute("style", previousStyle);
    }
  };
}

async function stabilizeFullPage(): Promise<{ width: number; height: number }> {
  const capturePageSize = {
    width: Math.max(
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
      document.body.scrollWidth,
    ),
    height: Math.max(
      document.documentElement.scrollHeight,
      document.documentElement.clientHeight,
      document.body.scrollHeight,
    ),
  };
  const result = await stabilizeFullPageScroll({
    viewportHeight: () => window.innerHeight,
    scrollHeight: () =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    scrollY: () => window.scrollY,
    scrollBy: (deltaY) => window.scrollBy(0, deltaY),
    scrollTo: (top) => window.scrollTo(0, top),
    wait: sleep,
  });
  capturePageSize.height = result.capturePageHeight;
  restorePageScrollToTop();
  await nextAnimationFrame();
  return capturePageSize;
}

async function settlePage(): Promise<void> {
  const fonts = document.fonts?.ready.catch(() => undefined) ?? Promise.resolve();
  const images = Promise.all(
    Array.from(document.images)
      .slice(0, 200)
      .map((image) => image.decode().catch(() => undefined)),
  );
  await Promise.race([Promise.all([fonts, images]), sleep(3_000)]);
  await nextAnimationFrame();
}

async function sendForRun<T = unknown>(
  command: RunCaptureCommand,
  payload: Omit<ContentMessage, keyof RunCaptureCommand | "document" | "code">,
): Promise<T> {
  assertActive(command);
  return chrome.runtime.sendMessage({
    ...payload,
    runId: command.runId,
    tabId: command.tabId,
    documentId: command.documentId,
  }) as Promise<T>;
}

function assertActive(command: RunCaptureCommand): void {
  if (!isActive(command)) throw new Error("Capture run is stale");
}

function isActive(command: RunCaptureCommand): boolean {
  return (
    activeCommand?.runId === command.runId &&
    activeCommand.tabId === command.tabId &&
    activeCommand.documentId === command.documentId
  );
}

function isRunCaptureCommand(value: unknown): value is RunCaptureCommand {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RunCaptureCommand>;
  return (
    candidate.type === "run-capture" &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    Number.isInteger(candidate.tabId) &&
    (candidate.tabId ?? -1) >= 0 &&
    typeof candidate.documentId === "string" &&
    candidate.documentId.length > 0 &&
    CAPTURE_MODES.includes(candidate.mode as RunCaptureCommand["mode"]) &&
    isPopupMessage({
      type: "start-capture",
      mode: candidate.mode,
      options: candidate.options,
    })
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export {};
