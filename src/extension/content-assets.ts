import {
  isSafeSvgMarkup,
  type CaptureAsset,
  type CaptureNode,
  type CaptureWarning,
  type CaptureWarningCode,
  type Paint,
} from "../core/contracts/capture.js";
import type {
  InPageInlineAsset,
} from "../core/capture/in-page-extractor.js";

export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 18 * 1024 * 1024;

export interface CaptureAssetCandidate {
  assetId: string;
  sourceKind: "svg-image" | "svg-inline" | "raster-image";
  bytes: Uint8Array;
  mediaType: string;
  tint?: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface RasterizedCaptureAsset {
  dataUrl: string;
  byteSize: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

export type CaptureAssetRasterizer = (input: {
  bytes: Uint8Array;
  mediaType: string;
  tint?: string;
}) => Promise<RasterizedCaptureAsset | null>;

const DIRECT_CLIPBOARD_RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
]);

export async function normalizeCaptureAsset(
  candidate: CaptureAssetCandidate,
  rasterize?: CaptureAssetRasterizer,
): Promise<CaptureAsset | null> {
  if (candidate.bytes.byteLength <= 0 || candidate.bytes.byteLength > MAX_ASSET_BYTES) {
    return null;
  }
  const factualMediaType = normalizeMediaType(candidate.mediaType);
  const mediaType = factualMediaType
    ? factualMediaType
    : candidate.sourceKind === "svg-image" || candidate.sourceKind === "svg-inline"
      ? "image/svg+xml"
      : "";

  if (mediaType === "image/svg+xml") {
    const source = new TextDecoder().decode(candidate.bytes);
    if (isSafeSvgMarkup(source)) {
      if (usesModernSvgColorFunction(source)) {
        return rasterizeCaptureAsset(candidate, mediaType, rasterize);
      }
      const data = candidate.tint === undefined ? source : tintSvgMarkup(source, candidate.tint);
      if (data === null || !isSafeSvgMarkup(data)) return null;
      const byteSize = new TextEncoder().encode(data).byteLength;
      if (byteSize > MAX_ASSET_BYTES) return null;
      return {
        assetId: candidate.assetId,
        kind: candidate.sourceKind === "svg-inline" ? "svg-inline" : "svg-image",
        data,
        mediaType,
        byteSize,
        ...(candidate.naturalWidth === undefined
          ? {}
          : { naturalWidth: candidate.naturalWidth }),
        ...(candidate.naturalHeight === undefined
          ? {}
          : { naturalHeight: candidate.naturalHeight }),
      };
    }
    if (!isSafeStaticStyledSvg(source)) return null;
    return rasterizeCaptureAsset(candidate, mediaType, rasterize);
  }

  if (!mediaType.startsWith("image/")) return null;
  if (!DIRECT_CLIPBOARD_RASTER_TYPES.has(mediaType) || candidate.tint !== undefined) {
    return rasterizeCaptureAsset(candidate, mediaType, rasterize);
  }
  return {
    assetId: candidate.assetId,
    kind: "raster-image",
    data: `data:${mediaType};base64,${bytesToBase64(candidate.bytes)}`,
    mediaType,
    byteSize: candidate.bytes.byteLength,
    ...(candidate.naturalWidth === undefined ? {} : { naturalWidth: candidate.naturalWidth }),
    ...(candidate.naturalHeight === undefined ? {} : { naturalHeight: candidate.naturalHeight }),
  };
}

export function partitionCaptureInlineAssets(
  assets: readonly InPageInlineAsset[],
): { primary: InPageInlineAsset[]; deferred: InPageInlineAsset[] } {
  const primary: InPageInlineAsset[] = [];
  const deferred: InPageInlineAsset[] = [];
  for (const asset of assets) {
    (asset.deferred === true ? deferred : primary).push(asset);
  }
  return { primary, deferred };
}

export function markUnresolvedImageNodes(
  root: CaptureNode,
  assets: readonly CaptureAsset[],
): void {
  const resolvedAssetIds = new Set(assets.map((asset) => asset.assetId));
  const visit = (node: CaptureNode): void => {
    if (
      node.type === "image" &&
      node.assetId !== undefined &&
      !resolvedAssetIds.has(node.assetId)
    ) {
      node.assetMissing = true;
    }
    if (node.type !== "element") return;
    for (const child of node.children) visit(child);
  };
  visit(root);
}

export function collectAssetNodeIds(root: CaptureNode): Map<string, Set<string>> {
  const nodeIdsByAsset = new Map<string, Set<string>>();
  const register = (assetId: string, nodeId: string): void => {
    const nodeIds = nodeIdsByAsset.get(assetId) ?? new Set<string>();
    nodeIds.add(nodeId);
    nodeIdsByAsset.set(assetId, nodeIds);
  };
  const registerPaints = (nodeId: string, paints: readonly Paint[]): void => {
    for (const paint of paints) {
      if (paint.type === "image") register(paint.assetId, nodeId);
    }
  };
  const visit = (node: CaptureNode): void => {
    if ((node.type === "image" || node.type === "svg") && node.assetId !== undefined) {
      register(node.assetId, node.id);
    }
    if (node.type === "text" && node.fillClip !== undefined) {
      registerPaints(node.id, node.fillClip.fills);
    }
    if (node.type === "element") {
      registerPaints(node.id, node.fills);
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return nodeIdsByAsset;
}

export function buildAssetWarnings(
  code: CaptureWarningCode,
  assetId: string,
  nodeIdsByAsset: ReadonlyMap<string, ReadonlySet<string>>,
): CaptureWarning[] {
  const nodeIds = nodeIdsByAsset.get(assetId);
  if (nodeIds === undefined || nodeIds.size === 0) {
    return [{ code, count: 1, detail: assetId }];
  }
  return Array.from(nodeIds, (nodeId) => ({
    code,
    nodeId,
    count: 1,
    detail: assetId,
  }));
}

export function tintSvgMarkup(svg: string, tint: string): string | null {
  if (!isSafeSvgMarkup(svg) || !isSafeTint(tint)) return null;
  let tinted = svg
    .replace(/currentColor/giu, tint)
    .replace(/fill="(?!none")[^"]*"/giu, `fill="${tint}"`)
    .replace(/fill:\s*(?!none)[^;"'}]+/giu, `fill:${tint}`);
  if (!/<svg\b[^>]*\bfill=/iu.test(tinted)) {
    tinted = tinted.replace(/<svg\b/iu, `<svg fill="${tint}"`);
  }
  return isSafeSvgMarkup(tinted) ? tinted : null;
}

export function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function usesModernSvgColorFunction(source: string): boolean {
  return /(?:^|[^\w-])(?:oklch|oklab|lch|lab|color)\s*\(/iu.test(source);
}

function isSafeStaticStyledSvg(source: string): boolean {
  const styles: string[] = [];
  const withoutStyles = source.replace(
    /<style(?:\s+type=(?:"text\/css"|'text\/css'))?\s*>([\s\S]*?)<\/style\s*>/giu,
    (_match, css: string) => {
      styles.push(css);
      return "";
    },
  );
  return (
    styles.length > 0 &&
    !/<\/?style\b/iu.test(withoutStyles) &&
    isSafeSvgMarkup(withoutStyles) &&
    styles.every(isSafeStaticSvgCss)
  );
}

function isSafeStaticSvgCss(source: string): boolean {
  if (
    source.length > 64_000 ||
    /(?:@|url\s*\(|expression\s*\(|var\s*\(|env\s*\(|attr\s*\(|javascript:|behavior\s*:|-moz-binding|\\)/iu.test(
      source,
    )
  ) {
    return false;
  }
  const css = source.replace(/\/\*[\s\S]*?\*\//gu, "").trim();
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/gu));
  if (rules.length === 0 || css.replace(/([^{}]+)\{([^{}]*)\}/gu, "").trim() !== "") {
    return false;
  }
  const allowedProperties = new Set([
    "color",
    "display",
    "fill",
    "fill-opacity",
    "fill-rule",
    "opacity",
    "stop-color",
    "stop-opacity",
    "stroke",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-width",
    "visibility",
  ]);
  return rules.every((rule) => {
    const selector = rule[1]?.trim() ?? "";
    const declarations = rule[2]?.trim() ?? "";
    if (!/^[.#]?[a-z_][\w-]*(?:\s*,\s*[.#]?[a-z_][\w-]*)*$/iu.test(selector)) {
      return false;
    }
    return declarations
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .every((declaration) => {
        const separator = declaration.indexOf(":");
        if (separator <= 0) return false;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        const value = declaration.slice(separator + 1).trim();
        return (
          allowedProperties.has(property) &&
          value.length > 0 &&
          value.length <= 256 &&
          !/[<>{};@\\]/u.test(value)
        );
      });
  });
}

async function rasterizeCaptureAsset(
  candidate: CaptureAssetCandidate,
  mediaType: string,
  rasterize: CaptureAssetRasterizer | undefined,
): Promise<CaptureAsset | null> {
  if (rasterize === undefined) return null;
  const result = await rasterize({
    bytes: candidate.bytes,
    mediaType,
    ...(candidate.tint === undefined ? {} : { tint: candidate.tint }),
  });
  if (
    result === null ||
    result.byteSize <= 0 ||
    result.byteSize > MAX_ASSET_BYTES ||
    !result.dataUrl.startsWith("data:image/png;base64,")
  ) {
    return null;
  }
  return {
    assetId: candidate.assetId,
    kind: "raster-image",
    data: result.dataUrl,
    mediaType: "image/png",
    byteSize: result.byteSize,
    ...((result.naturalWidth ?? candidate.naturalWidth) === undefined
      ? {}
      : { naturalWidth: result.naturalWidth ?? candidate.naturalWidth }),
    ...((result.naturalHeight ?? candidate.naturalHeight) === undefined
      ? {}
      : { naturalHeight: result.naturalHeight ?? candidate.naturalHeight }),
  };
}

function isSafeTint(value: string): boolean {
  return value.length > 0 && value.length <= 100 && !/[<>&"']/u.test(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
