import type {
  CaptureAsset,
  CaptureElementNode,
  CaptureImageNode,
  CaptureNode,
  CaptureWarning,
  PageRect,
} from "../core/contracts/capture.js";

export const CAPTURE_MARKER_ATTRIBUTES = [
  "data-h2f-shot",
  "data-h2f-background-shot",
  "data-h2f-backdrop-source-for",
] as const;

export interface ScreenshotFallbackNode {
  nodeId: string;
  rect: PageRect;
  tag: string;
  preserveBackdrop: boolean;
  kind: "image-node" | "background-host";
}

export interface AncestorScrollPosition {
  element: Element;
  x: number;
  y: number;
}

export const LOCAL_STATIC_PROFILE_ID = "local-static-v1";
export const LOCAL_STATIC_SCREENSHOT_LIMIT = 12;

export function localStaticSettleDelayMs(tag: string): number {
  return tag === "canvas" ? 120 : 60;
}

export function captureAncestorScrollPositions(target: Element): AncestorScrollPosition[] {
  const positions: AncestorScrollPosition[] = [];
  let ancestor = target.parentElement;
  while (ancestor !== null) {
    positions.push({
      element: ancestor,
      x: ancestor.scrollLeft,
      y: ancestor.scrollTop,
    });
    ancestor = ancestor.parentElement;
  }
  return positions;
}

export function restoreAncestorHorizontalScroll(
  positions: readonly AncestorScrollPosition[],
): void {
  for (const position of positions) {
    position.element.scrollLeft = position.x;
  }
}

export function restoreAncestorScrollPositions(
  positions: readonly AncestorScrollPosition[],
): void {
  for (const position of positions) {
    position.element.scrollLeft = position.x;
    position.element.scrollTop = position.y;
  }
}

export type ApplyScreenshotFallbackResult =
  | { applied: true; byteSize: number; assetId: string }
  | { applied: false; reason: "node-missing" | "invalid-data" | "asset-too-large" };

export type LocalStaticFallbackFailureReason =
  | Exclude<ApplyScreenshotFallbackResult, { applied: true }>["reason"]
  | "capture-unavailable"
  | "deferred";

export interface LocalStaticFallbackFailure {
  nodeId: string;
  reason: LocalStaticFallbackFailureReason;
}

export interface LocalStaticFallbackResolution {
  attemptedCount: number;
  appliedCount: number;
  failures: LocalStaticFallbackFailure[];
  warnings: CaptureWarning[];
}

export function planScreenshotFallbackAttempts(
  requests: readonly ScreenshotFallbackNode[],
  limit: number,
): { attempts: ScreenshotFallbackNode[]; deferred: ScreenshotFallbackNode[] } {
  const ranked = requests
    .map((request, index) => ({ request, index }))
    .sort((left, right) => {
      const kindDifference =
        Number(left.request.kind === "background-host") -
        Number(right.request.kind === "background-host");
      if (kindDifference !== 0) return kindDifference;
      const areaDifference =
        right.request.rect.width * right.request.rect.height -
        left.request.rect.width * left.request.rect.height;
      return areaDifference || left.index - right.index;
    })
    .map(({ request }) => request);
  const boundedLimit = Math.max(0, Math.floor(limit));
  return {
    attempts: ranked.slice(0, boundedLimit),
    deferred: ranked.slice(boundedLimit),
  };
}

export function collectScreenshotFallbackNodes(
  root: CaptureNode,
  resolvedAssetIds?: ReadonlySet<string>,
): ScreenshotFallbackNode[] {
  const nodes: ScreenshotFallbackNode[] = [];
  const visit = (node: CaptureNode, isRoot: boolean): void => {
    if (node.type === "image" && node.assetMissing === true) {
      nodes.push({
        nodeId: node.id,
        rect: node.bounds,
        tag: node.tag,
        preserveBackdrop: node.fallbackLabel === "backdrop-composite",
        kind: "image-node",
      });
      return;
    }
    if (node.type !== "element") return;
    const canCaptureBackground =
      !isRoot &&
      resolvedAssetIds !== undefined &&
      node.fills.some(
        (fill) => fill.type === "image" && !resolvedAssetIds.has(fill.assetId),
      ) &&
      node.bounds.width > 0 &&
      node.bounds.height > 0 &&
      node.bounds.width <= 4_096 &&
      node.bounds.height <= 4_096 &&
      node.bounds.width * node.bounds.height <= 8_000_000;
    if (canCaptureBackground) {
      nodes.push({
        nodeId: node.id,
        rect: node.bounds,
        tag: node.tag,
        preserveBackdrop: false,
        kind: "background-host",
      });
    }
    for (const child of node.children) visit(child, false);
  };
  visit(root, true);
  return nodes;
}

export async function resolveLocalStaticScreenshotFallbacks(options: {
  root: CaptureNode;
  assets: CaptureAsset[];
  capture: (request: ScreenshotFallbackNode) => Promise<string | null>;
  maxAssetBytes: number;
  maxTotalAssetBytes: number;
}): Promise<LocalStaticFallbackResolution> {
  const resolvedAssetIds = new Set(options.assets.map((asset) => asset.assetId));
  const requests = collectScreenshotFallbackNodes(options.root, resolvedAssetIds);
  const { attempts, deferred } = planScreenshotFallbackAttempts(
    requests,
    LOCAL_STATIC_SCREENSHOT_LIMIT,
  );
  const failures: LocalStaticFallbackFailure[] = [];
  let appliedCount = 0;

  for (const request of attempts) {
    const dataUrl = await options.capture(request);
    if (dataUrl === null) {
      if (request.kind === "image-node") {
        markFallbackUnavailable(
          options.root,
          request.nodeId,
          "single-frame capture unavailable",
          1,
        );
      }
      failures.push({ nodeId: request.nodeId, reason: "capture-unavailable" });
      continue;
    }
    const result = applyScreenshotFallbackAsset({
      root: options.root,
      assets: options.assets,
      nodeId: request.nodeId,
      dataUrl,
      maxAssetBytes: options.maxAssetBytes,
      maxTotalAssetBytes: options.maxTotalAssetBytes,
      kind: request.kind,
    });
    if (result.applied) {
      appliedCount += 1;
      continue;
    }
    if (request.kind === "image-node") {
      markFallbackUnavailable(
        options.root,
        request.nodeId,
        `single-frame capture ${result.reason}`,
        1,
      );
    }
    failures.push({ nodeId: request.nodeId, reason: result.reason });
  }

  for (const request of deferred) {
    if (request.kind === "image-node") {
      markFallbackUnavailable(
        options.root,
        request.nodeId,
        `${LOCAL_STATIC_PROFILE_ID} ${LOCAL_STATIC_SCREENSHOT_LIMIT}-region limit`,
        0,
      );
    }
    failures.push({ nodeId: request.nodeId, reason: "deferred" });
  }

  return {
    attemptedCount: attempts.length,
    appliedCount,
    failures,
    warnings: failures.map((failure) => ({
      code:
        failure.reason === "asset-too-large"
          ? "asset_too_large"
          : "dynamic_frame_unavailable",
      nodeId: failure.nodeId,
      count: 1,
      detail: localStaticFailureDetail(failure.reason),
    })),
  };
}

function localStaticFailureDetail(reason: LocalStaticFallbackFailureReason): string {
  switch (reason) {
    case "asset-too-large":
      return "single-frame screenshot exceeded the local asset budget";
    case "deferred":
      return `${LOCAL_STATIC_PROFILE_ID} ${LOCAL_STATIC_SCREENSHOT_LIMIT}-region limit`;
    case "capture-unavailable":
      return "single-frame screenshot unavailable";
    case "invalid-data":
      return "single-frame screenshot returned invalid PNG data";
    case "node-missing":
      return "single-frame screenshot target disappeared";
  }
}

export function applyScreenshotFallbackAsset(options: {
  root: CaptureNode;
  assets: CaptureAsset[];
  nodeId: string;
  dataUrl: string;
  maxAssetBytes: number;
  maxTotalAssetBytes: number;
  kind?: ScreenshotFallbackNode["kind"];
}): ApplyScreenshotFallbackResult {
  const kind = options.kind ?? "image-node";
  const node =
    kind === "background-host"
      ? findElementNode(options.root, options.nodeId)
      : findImageNode(options.root, options.nodeId);
  if (!node) return { applied: false, reason: "node-missing" };

  const byteSize = estimateDataUriBytes(options.dataUrl);
  if (byteSize <= 0 || !options.dataUrl.startsWith("data:image/png;base64,")) {
    return { applied: false, reason: "invalid-data" };
  }
  const currentTotal = options.assets.reduce((total, asset) => total + asset.byteSize, 0);
  if (
    byteSize > options.maxAssetBytes ||
    currentTotal + byteSize > options.maxTotalAssetBytes
  ) {
    return { applied: false, reason: "asset-too-large" };
  }

  const assetId = `${kind === "background-host" ? "shot-background" : "shot"}-${options.nodeId}`;
  options.assets.push({
    assetId,
    kind: "raster-image",
    data: options.dataUrl,
    mediaType: "image/png",
    byteSize,
    safeSourceLabel:
      kind === "background-host"
        ? "screenshot-fallback:background"
        : `screenshot-fallback:${node.tag}`,
  });
  if (kind === "background-host") {
    (node as CaptureElementNode).fills = [{ type: "image", assetId, scaleMode: "fill" }];
  } else {
    const imageNode = node as CaptureImageNode;
    imageNode.assetId = assetId;
    delete imageNode.assetMissing;
    delete imageNode.renderFallback;
    delete imageNode.fallbackLabel;
    imageNode.opacity = 1;
  }
  return { applied: true, byteSize, assetId };
}

function markFallbackUnavailable(
  root: CaptureNode,
  nodeId: string,
  label: string,
  sampleCount: number,
): void {
  const node = findImageNode(root, nodeId);
  if (node === null) return;
  node.renderFallback = true;
  node.fallbackLabel = label;
  node.rasterCapture = {
    status: "unavailable",
    sampleCount,
  };
}

export function cleanupCaptureMarkers(root: Document | ShadowRoot = document): void {
  for (const attribute of CAPTURE_MARKER_ATTRIBUTES) {
    root.querySelectorAll(`[${attribute}]`).forEach((element) => {
      element.removeAttribute(attribute);
    });
  }
  root.querySelectorAll("*").forEach((element) => {
    if (element.shadowRoot) cleanupCaptureMarkers(element.shadowRoot);
  });
}

export function findCaptureMarker(
  nodeId: string,
  root: Document | ShadowRoot = document,
  kind: ScreenshotFallbackNode["kind"] = "image-node",
): Element | null {
  const attribute = kind === "background-host" ? "data-h2f-background-shot" : "data-h2f-shot";
  const direct = root.querySelector(`[${attribute}="${cssEscape(nodeId)}"]`);
  if (direct) return direct;
  for (const element of root.querySelectorAll("*")) {
    if (!element.shadowRoot) continue;
    const nested = findCaptureMarker(nodeId, element.shadowRoot, kind);
    if (nested) return nested;
  }
  return null;
}

export function screenshotFallbackPageClip(
  capturedRect: PageRect,
  liveViewportRect: PageRect,
  scroll: { x: number; y: number },
): PageRect | null {
  const livePageRect = {
    x: liveViewportRect.x + scroll.x,
    y: liveViewportRect.y + scroll.y,
    width: liveViewportRect.width,
    height: liveViewportRect.height,
  };
  const dimensionsMatch =
    Math.abs(capturedRect.width - livePageRect.width) <= 1 &&
    Math.abs(capturedRect.height - livePageRect.height) <= 1;
  if (dimensionsMatch && isValidScreenshotRect(livePageRect)) return livePageRect;
  if (isValidScreenshotRect(capturedRect)) return { ...capturedRect };
  return isValidScreenshotRect(livePageRect) ? livePageRect : null;
}

export function estimateDataUriBytes(data: string): number {
  if (!data.startsWith("data:")) return new TextEncoder().encode(data).byteLength;
  const commaIndex = data.indexOf(",");
  if (commaIndex < 0) return 0;
  const metadata = data.slice(0, commaIndex);
  const payload = data.slice(commaIndex + 1);
  if (!metadata.toLowerCase().includes(";base64")) {
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch {
      return 0;
    }
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function walkCaptureNodes(node: CaptureNode, visitor: (node: CaptureNode) => void): void {
  visitor(node);
  if (node.type !== "element") return;
  for (const child of node.children) walkCaptureNodes(child, visitor);
}

function findImageNode(root: CaptureNode, nodeId: string): CaptureImageNode | null {
  let found: CaptureImageNode | null = null;
  walkCaptureNodes(root, (node) => {
    if (!found && node.type === "image" && node.id === nodeId) found = node;
  });
  return found;
}

function findElementNode(root: CaptureNode, nodeId: string): CaptureElementNode | null {
  let found: CaptureElementNode | null = null;
  walkCaptureNodes(root, (node) => {
    if (!found && node.type === "element" && node.id === nodeId) found = node;
  });
  return found;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isValidScreenshotRect(rect: PageRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= 1 &&
    rect.height >= 1
  );
}
