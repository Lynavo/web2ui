/**
 * In-page DOM extractor.
 *
 * `extractCaptureInPage` is serialized by Playwright and executed inside the
 * browser. It MUST stay fully self-contained: no imports may be referenced at
 * runtime (type-only imports are fine — they are erased).
 *
 * It walks the rendered DOM and produces a style-complete capture tree plus a
 * list of asset requests (images/backgrounds) that the Node side resolves via
 * the Playwright request context (bypassing page CORS).
 */

import type {
  Borders,
  CaptureFont,
  CaptureNode,
  CaptureElementNode,
  CaptureWarning,
  CornerRadii,
  FlexLayoutHint,
  Padding,
  Paint,
  PageRect,
  RgbaColor,
  Shadow,
  TextLineBox,
  TextSegment,
  TextStyle,
} from "../contracts/capture.js";

export interface InPageAssetRequest {
  assetId: string;
  url: string;
  kind: "raster-image" | "svg-image";
  /** Browser-decoded intrinsic size when CSS sizing needs the image ratio. */
  naturalWidth?: number;
  naturalHeight?: number;
  /**
   * Tint fact for CSS mask icons. The shape comes from the mask image's alpha
   * channel and the color comes from the element background. After downloading
   * the SVG, the engine bakes in this color as a regular image asset so
   * downstream renderers do not need to understand masks.
   */
  tint?: string;
}

export interface InPageInlineAsset {
  assetId: string;
  kind: "svg-inline" | "raster-image";
  /** Raw SVG markup or data URI for canvas rasterizations. */
  data: string;
  mediaType: string;
  naturalWidth?: number;
  naturalHeight?: number;
  /** Process only after page imagery so fidelity fallbacks cannot starve it. */
  deferred?: boolean;
}

export interface InPageExtractionResult {
  root: CaptureElementNode;
  assetRequests: InPageAssetRequest[];
  inlineAssets: InPageInlineAsset[];
  fonts: CaptureFont[];
  warnings: CaptureWarning[];
  pageWidth: number;
  pageHeight: number;
  pageBackground: RgbaColor;
  nodeCount: number;
  textNodeCount: number;
  imageNodeCount: number;
}

export interface InPageExtractorOptions {
  maxNodes: number;
  /**
   * Preserve browser-rendered glyph pixels for authored/unsupported faces.
   * This is deliberately not a blanket "rasterize every text node" switch:
   * system-font text remains editable and decorated text keeps its measured
   * underline/strike semantics.
   */
  captureTextFallbacks?: boolean;
  /**
   * Full-page captures may opt into a bounded browser-fact pass that retains
   * children evicted by document-level virtual lists while scrolling. Normal
   * viewport/element extraction keeps the single-snapshot path.
   */
  captureVirtualizedContent?: boolean;
  /**
   * Browser-measured document size captured before a full-page lazy-load
   * sweep. Supplying it keeps load-more mutations caused by that sweep
   * outside the current capture frontier.
   */
  capturePageSize?: { width: number; height: number };
  /**
   * Optional page-coordinate rectangle for Chrome's current-viewport mode.
   * The extractor keeps only content that contributes inside this rectangle,
   * then rebases every retained browser measurement to its top-left corner.
   */
  viewportClip?: PageRect;
}

export const DEFAULT_CAPTURE_MAX_NODES = 20_000;

/**
 * Restore every temporary DOM marker written by `extractCaptureInPage`.
 *
 * The Chrome extension runs extraction in the user's live tab, so marker
 * cleanup must restore authored values exactly instead of blindly removing
 * `data-h2f-*` attributes. The element set is kept separately because a site
 * may mutate or remove the temporary attribute before capture finishes.
 */
export function cleanupCaptureMarkersInPage(): void {
  const globals = window as unknown as Record<string, unknown>;
  const states = globals.__h2fCaptureMarkerStates as
    | WeakMap<Element, Map<string, { hadAttribute: boolean; value: string | null }>>
    | undefined;
  const elements = globals.__h2fCaptureMarkerElements as Set<Element> | undefined;
  if (states === undefined || elements === undefined) return;
  for (const element of elements) {
    const elementStates = states.get(element);
    if (elementStates === undefined) continue;
    for (const [attribute, state] of elementStates) {
      if (state.hadAttribute) {
        element.setAttribute(attribute, state.value ?? "");
      } else {
        element.removeAttribute(attribute);
      }
    }
    elementStates.clear();
    states.delete(element);
  }
  elements.clear();
}

export async function extractCaptureInPage(
  options: InPageExtractorOptions,
): Promise<InPageExtractionResult> {
  // Keep this literal aligned with DEFAULT_CAPTURE_MAX_NODES. Playwright
  // serializes this function into the page, so it cannot close over module
  // constants at runtime.
  const maxNodes = options.maxNodes > 0 ? options.maxNodes : 20_000;
  const captureTextFallbacks = options.captureTextFallbacks !== false;

  let nodeSequence = 0;
  let assetSequence = 0;
  let nodeCount = 0;
  let textNodeCount = 0;
  let imageNodeCount = 0;
  let truncated = false;

  const assetRequests: InPageAssetRequest[] = [];
  const inlineAssets: InPageInlineAsset[] = [];
  const assetIdByUrl = new Map<string, string>();
  const warningCounts = new Map<
    string,
    { code: string; count: number; detail?: string; nodeId?: string }
  >();

  const initialScrollX = window.scrollX;
  const initialScrollY = window.scrollY;
  const observedPageWidth = Math.max(
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  );
  const observedPageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.documentElement.clientHeight,
  );
  const suppliedPageWidth = options.capturePageSize?.width;
  const suppliedPageHeight = options.capturePageSize?.height;
  const capturePageWidth =
    suppliedPageWidth !== undefined && Number.isFinite(suppliedPageWidth) && suppliedPageWidth > 0
      ? Math.max(document.documentElement.clientWidth, suppliedPageWidth)
      : observedPageWidth;
  const capturePageHeight =
    suppliedPageHeight !== undefined &&
    Number.isFinite(suppliedPageHeight) &&
    suppliedPageHeight > 0
      ? Math.max(document.documentElement.clientHeight, suppliedPageHeight)
      : observedPageHeight;
  let scrollX = initialScrollX;
  let scrollY = initialScrollY;
  const virtualizedCapturedChildren = new Map<Element, CaptureNode[]>();
  const virtualizedInsertedNodes: Array<{
    parent: CaptureElementNode;
    node: CaptureNode;
  }> = [];

  function nextNodeId(): string {
    nodeSequence += 1;
    return `n_${String(nodeSequence).padStart(6, "0")}`;
  }

  function addWarning(code: string, detail?: string, nodeId?: string): void {
    const key = nodeId === undefined ? code : `${code}\u0000${nodeId}`;
    const existing = warningCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      warningCounts.set(key, {
        code,
        count: 1,
        ...(detail !== undefined ? { detail } : {}),
        ...(nodeId !== undefined ? { nodeId } : {}),
      });
    }
  }

  function registerRemoteAsset(
    url: string,
    kind: "raster-image" | "svg-image",
    tint?: string,
  ): string {
    // Different tints of the same mask are distinct assets (the key includes
    // the tint); regular images use the URL as their key.
    const key = tint === undefined ? url : `${url}\u0000${tint}`;
    const existing = assetIdByUrl.get(key);
    if (existing !== undefined) {
      return existing;
    }
    assetSequence += 1;
    const assetId = `asset_${String(assetSequence).padStart(4, "0")}`;
    assetIdByUrl.set(key, assetId);
    assetRequests.push({ assetId, url, kind, ...(tint === undefined ? {} : { tint }) });
    return assetId;
  }

  function registerInlineAsset(
    kind: "svg-inline" | "raster-image",
    data: string,
    mediaType: string,
    naturalWidth?: number,
    naturalHeight?: number,
    deferred = false,
  ): string {
    assetSequence += 1;
    const assetId = `asset_${String(assetSequence).padStart(4, "0")}`;
    inlineAssets.push({
      assetId,
      kind,
      data,
      mediaType,
      ...(naturalWidth !== undefined ? { naturalWidth } : {}),
      ...(naturalHeight !== undefined ? { naturalHeight } : {}),
      ...(deferred ? { deferred: true } : {}),
    });
    return assetId;
  }

  // -------------------------------------------------------------------------
  // Color / value parsing
  // -------------------------------------------------------------------------

  const cssNumberPattern = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?`;
  const srgbColorPattern = new RegExp(
    `^color\\(srgb\\s+(${cssNumberPattern})\\s+(${cssNumberPattern})\\s+(${cssNumberPattern})(?:\\s*\\/\\s*(${cssNumberPattern}))?\\)$`,
    "i",
  );

  function parseColor(
    input: string | null | undefined,
    preserveFullyTransparentRgb = false,
  ): RgbaColor | null {
    if (!input) {
      return null;
    }
    const value = input.trim();
    if (value === "transparent") {
      return preserveFullyTransparentRgb ? { r: 0, g: 0, b: 0, a: 0 } : null;
    }
    if (value === "none") {
      return null;
    }
    let match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      value,
    );
    if (match) {
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha === 0 && !preserveFullyTransparentRgb) {
        return null;
      }
      return {
        r: Number(match[1]) / 255,
        g: Number(match[2]) / 255,
        b: Number(match[3]) / 255,
        a: alpha,
      };
    }
    match = srgbColorPattern.exec(value);
    if (match) {
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha === 0 && !preserveFullyTransparentRgb) {
        return null;
      }
      return {
        r: clampUnit(Number(match[1])),
        g: clampUnit(Number(match[2])),
        b: clampUnit(Number(match[3])),
        a: clampUnit(alpha),
      };
    }
    return normalizeColorViaCanvas(value);
  }

  /**
   * Fallback for modern color spaces (lab, oklch, color-mix results, named
   * colors). A 1x1 canvas paints the color and reads back resolved sRGB.
   */
  let colorCanvasContext: CanvasRenderingContext2D | null | undefined;
  const canvasColorCache = new Map<string, RgbaColor | null>();

  function normalizeColorViaCanvas(value: string): RgbaColor | null {
    const cached = canvasColorCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    if (colorCanvasContext === undefined) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        colorCanvasContext = canvas.getContext("2d", { willReadFrequently: true });
      } catch {
        colorCanvasContext = null;
      }
    }
    if (!colorCanvasContext) {
      canvasColorCache.set(value, null);
      return null;
    }
    let result: RgbaColor | null = null;
    try {
      const ctx = colorCanvasContext;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = value;
      // Invalid colors leave fillStyle unchanged at #000000; paint and sample.
      ctx.fillRect(0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      const alphaByte = pixel[3] ?? 0;
      if (alphaByte > 0) {
        result = {
          r: (pixel[0] ?? 0) / 255,
          g: (pixel[1] ?? 0) / 255,
          b: (pixel[2] ?? 0) / 255,
          a: alphaByte / 255,
        };
      }
    } catch {
      result = null;
    }
    canvasColorCache.set(value, result);
    return result;
  }

  function parsePx(input: string | null | undefined): number {
    if (!input) {
      return 0;
    }
    const value = Number.parseFloat(input);
    return Number.isFinite(value) ? value : 0;
  }

  /** Split on top-level commas (respecting parentheses). */
  function splitTopLevel(input: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of input) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      if (char === separator && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim().length > 0) {
      parts.push(current.trim());
    }
    return parts;
  }

  // -------------------------------------------------------------------------
  // Gradient parsing
  // -------------------------------------------------------------------------

  interface RawStop {
    color: RgbaColor;
    position: number | null;
  }

  function clampUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  function parseGradientStops(parts: string[]): RawStop[] {
    const stops: RawStop[] = [];
    for (const part of parts) {
      const colorMatch =
        /(rgba?\([^)]*\)|color\([^)]*\)|(?:ok)?lab\([^)]*\)|oklch\([^)]*\)|lch\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(
          part,
        );
      const colorText = colorMatch?.[1];
      if (colorText === undefined) {
        continue;
      }
      const color = parseColor(colorText, true) ?? { r: 0, g: 0, b: 0, a: 0 };
      const rest = part.replace(colorText, "").trim();
      let position: number | null = null;
      const pctMatch = /(-?[\d.]+)%/.exec(rest);
      if (pctMatch) {
        position = Number(pctMatch[1]) / 100;
      }
      stops.push({ color, position });
    }
    // Interpolate missing positions.
    if (stops.length > 0) {
      if (stops[0] && stops[0].position === null) {
        stops[0].position = 0;
      }
      const last = stops[stops.length - 1];
      if (last && last.position === null) {
        last.position = 1;
      }
      let previousIndex = 0;
      for (let index = 1; index < stops.length; index += 1) {
        const stop = stops[index];
        if (!stop || stop.position === null) {
          continue;
        }
        const previous = stops[previousIndex];
        const previousPosition = previous && previous.position !== null ? previous.position : 0;
        const gap = index - previousIndex;
        if (gap > 1) {
          for (let fill = previousIndex + 1; fill < index; fill += 1) {
            const fillStop = stops[fill];
            if (fillStop) {
              fillStop.position =
                previousPosition + ((stop.position - previousPosition) * (fill - previousIndex)) / gap;
            }
          }
        }
        previousIndex = index;
      }
    }
    for (const stop of stops) {
      if (stop.position !== null) {
        stop.position = clampUnit(stop.position);
      }
    }
    return stops;
  }

  function parseGradient(layer: string, boxWidth = 0, boxHeight = 0): Paint | null {
    // Computed styles often keep the -webkit- prefix (Vue accent text uses
    // -webkit-linear-gradient with background-clip:text). Strip it so the
    // standard grammar below can parse the same stop list. Legacy webkit
    // angles use a different bearing (0deg = east, CCW) than standard
    // linear-gradient (0deg = north, CW); convert when the prefix was present.
    const trimmedLayer = layer.trim();
    const fromWebkitPrefix = /^-webkit-/i.test(trimmedLayer);
    const normalizedLayer = trimmedLayer.replace(/^-webkit-/i, "");
    const fnMatch =
      /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(normalizedLayer);
    if (!fnMatch) {
      return null;
    }
    const kind = fnMatch[2];
    const body = fnMatch[3] ?? "";
    const parts = splitTopLevel(body, ",");
    if (parts.length === 0) {
      return null;
    }

    if (kind === "linear") {
      let angleDegrees = 180; // CSS default: to bottom.
      let stopParts = parts;
      const first = parts[0] ?? "";
      const degMatch = /^(-?[\d.]+)deg$/.exec(first);
      const turnMatch = /^(-?[\d.]+)turn$/.exec(first);
      const radMatch = /^(-?[\d.]+)rad$/.exec(first);
      if (degMatch) {
        angleDegrees = Number(degMatch[1]);
        stopParts = parts.slice(1);
        if (fromWebkitPrefix) {
          // webkitBearing → standardBearing: standard = 90 - webkit (mod 360).
          angleDegrees = ((90 - angleDegrees) % 360 + 360) % 360;
        }
      } else if (turnMatch) {
        angleDegrees = Number(turnMatch[1]) * 360;
        stopParts = parts.slice(1);
        if (fromWebkitPrefix) {
          angleDegrees = ((90 - angleDegrees) % 360 + 360) % 360;
        }
      } else if (radMatch) {
        angleDegrees = (Number(radMatch[1]) * 180) / Math.PI;
        stopParts = parts.slice(1);
        if (fromWebkitPrefix) {
          angleDegrees = ((90 - angleDegrees) % 360 + 360) % 360;
        }
      } else if (first.startsWith("to ")) {
        const direction = first.slice(3).trim();
        const directionMap: Record<string, number> = {
          top: 0,
          "top right": 45,
          "right top": 45,
          right: 90,
          "bottom right": 135,
          "right bottom": 135,
          bottom: 180,
          "bottom left": 225,
          "left bottom": 225,
          left: 270,
          "top left": 315,
          "left top": 315,
        };
        angleDegrees = directionMap[direction] ?? 180;
        stopParts = parts.slice(1);
      }
      const stops = parseGradientStops(stopParts);
      if (stops.length < 2) {
        return null;
      }
      return {
        type: "linear-gradient",
        angleDegrees,
        stops: stops.map((stop) => ({ position: stop.position ?? 0, color: stop.color })),
      };
    }

    if (kind === "radial") {
      let stopParts = parts;
      const first = parts[0] ?? "";
      let prelude = "";
      if (!/rgba?\(|color\(/.test(first)) {
        prelude = first;
        stopParts = parts.slice(1);
      }
      const stops = parseGradientStops(stopParts);
      if (stops.length < 2) {
        return null;
      }
      // Parse "[circle|ellipse] [size] at <x> <y>". Computed style uses px
      // for positions, so resolve against the element box when available.
      const w = boxWidth > 0 ? boxWidth : 1;
      const h = boxHeight > 0 ? boxHeight : 1;
      let centerX = 0.5;
      let centerY = 0.5;
      const isCircle = /\bcircle\b/.test(prelude);
      const atMatch = /\bat\s+(.+)$/.exec(prelude);
      const resolveCoord = (token: string, size: number): number | undefined => {
        if (token === "left" || token === "top") return 0;
        if (token === "center") return 0.5;
        if (token === "right" || token === "bottom") return 1;
        const pct = /^(-?[\d.]+)%$/.exec(token);
        if (pct?.[1] !== undefined) return Number(pct[1]) / 100;
        const px = /^(-?[\d.]+)px$/.exec(token);
        if (px?.[1] !== undefined) return Number(px[1]) / size;
        return undefined;
      };
      if (atMatch?.[1] !== undefined) {
        const tokens = atMatch[1].trim().split(/\s+/);
        const cx = resolveCoord(tokens[0] ?? "center", w);
        const cy = resolveCoord(tokens[1] ?? "center", h);
        if (cx !== undefined) centerX = cx;
        if (cy !== undefined) centerY = cy;
      }
      // Gradient end shape size. Computed style may inline explicit radii
      // (e.g. "1086px at 0px 100%"); otherwise use the sizing keyword
      // (default farthest-corner).
      let radiusX: number;
      let radiusY: number;
      const beforeAt = atMatch ? prelude.slice(0, atMatch.index) : prelude;
      const explicit = beforeAt.match(/(-?[\d.]+)(px|%)/g);
      const dxMax = Math.max(centerX, 1 - centerX);
      const dyMax = Math.max(centerY, 1 - centerY);
      if (explicit && explicit.length >= 1) {
        const toFrac = (token: string, size: number): number =>
          token.endsWith("%") ? Number.parseFloat(token) / 100 : Number.parseFloat(token) / size;
        radiusX = toFrac(explicit[0] ?? "50%", w);
        radiusY = explicit.length >= 2 ? toFrac(explicit[1] ?? "50%", h) : (radiusX * w) / h;
      } else if (/closest-side/.test(prelude)) {
        const rx = Math.min(centerX, 1 - centerX);
        const ry = Math.min(centerY, 1 - centerY);
        if (isCircle) {
          const r = Math.min(rx * w, ry * h);
          radiusX = r / w;
          radiusY = r / h;
        } else {
          radiusX = rx;
          radiusY = ry;
        }
      } else if (/farthest-side/.test(prelude)) {
        if (isCircle) {
          const r = Math.max(dxMax * w, dyMax * h);
          radiusX = r / w;
          radiusY = r / h;
        } else {
          radiusX = dxMax;
          radiusY = dyMax;
        }
      } else if (isCircle) {
        // farthest-corner circle: radius reaches the farthest corner.
        const r = Math.hypot(dxMax * w, dyMax * h);
        radiusX = r / w;
        radiusY = r / h;
      } else {
        // farthest-corner ellipse (CSS default).
        radiusX = dxMax * Math.SQRT2;
        radiusY = dyMax * Math.SQRT2;
      }
      return {
        type: "radial-gradient",
        centerX,
        centerY,
        radiusX,
        radiusY,
        stops: stops.map((stop) => ({ position: stop.position ?? 0, color: stop.color })),
      };
    }

    // conic
    let stopParts = parts;
    let angleDegrees = 0;
    const first = parts[0] ?? "";
    const fromMatch = /^from\s+(-?[\d.]+)deg/.exec(first);
    if (fromMatch) {
      angleDegrees = Number(fromMatch[1]);
      stopParts = parts.slice(1);
    } else if (!/rgba?\(|color\(/.test(first)) {
      stopParts = parts.slice(1);
    }
    const stops = parseGradientStops(stopParts);
    if (stops.length < 2) {
      return null;
    }
    return {
      type: "conic-gradient",
      centerX: 0.5,
      centerY: 0.5,
      angleDegrees,
      stops: stops.map((stop) => ({ position: stop.position ?? 0, color: stop.color })),
    };
  }

  // -------------------------------------------------------------------------
  // Style extraction helpers
  // -------------------------------------------------------------------------

  /** Decode CSS escapes after extracting the contents of a url() token. */
  function unescapeCssValue(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (char !== "\\") {
        result += char;
        continue;
      }
      const next = value[index + 1];
      if (next === undefined) {
        result += "\uFFFD";
        continue;
      }
      // CSS line continuation: a backslash immediately followed by a
      // newline (CRLF counts as one newline) contributes no character.
      if (next === "\n" || next === "\f") {
        index += 1;
        continue;
      }
      if (next === "\r") {
        index += value[index + 2] === "\n" ? 2 : 1;
        continue;
      }
      if (/[0-9a-fA-F]/.test(next)) {
        let end = index + 1;
        while (end < value.length && end < index + 7 && /[0-9a-fA-F]/.test(value[end]!)) {
          end += 1;
        }
        const codePoint = Number.parseInt(value.slice(index + 1, end), 16);
        result +=
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? "\uFFFD"
            : String.fromCodePoint(codePoint);
        // One whitespace code point after a hex escape terminates it. Treat
        // CRLF as the single newline token defined by CSS Syntax.
        const terminator = value[end];
        if (
          terminator === " " ||
          terminator === "\t" ||
          terminator === "\n" ||
          terminator === "\r" ||
          terminator === "\f"
        ) {
          if (value[end] === "\r" && value[end + 1] === "\n") end += 1;
          end += 1;
        }
        index = end - 1;
        continue;
      }
      // Ordinary escape (including escaped quote/backslash).
      result += next;
      index += 1;
    }
    return result;
  }

  /** Parse a single computed url(...) layer and return its decoded CSS value. */
  function parseCssUrl(layer: string): string | null {
    const value = layer.trim();
    if (!value.startsWith("url(") || !value.endsWith(")")) {
      return null;
    }
    const token = value.slice(4, -1).trim();
    if (token.length === 0) return null;
    const quote = token[0];
    if (quote === '"' || quote === "'") {
      if (token.length < 2 || token[token.length - 1] !== quote) return null;
      return unescapeCssValue(token.slice(1, -1));
    }
    return unescapeCssValue(token);
  }

  function resolveUrl(rawUrl: string): string | null {
    try {
      const resolved = new URL(rawUrl, document.baseURI);
      if (resolved.protocol === "data:") {
        return resolved.href;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return null;
      }
      return resolved.href;
    } catch {
      return null;
    }
  }

  function scaleModeFromCss(value: string): "fill" | "fit" | "crop" | "tile" {
    switch (value) {
      case "contain":
        return "fit";
      case "none":
        return "crop";
      default:
        return "fill";
    }
  }

  function parseBackgroundPositionAxis(
    rawValue: string,
  ): { percentage?: number; offsetPx?: number } | null {
    const value = rawValue.trim();
    let match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))%$/.exec(value);
    if (match) return { percentage: Number(match[1]) / 100 };
    match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(value);
    if (match) return { offsetPx: Number(match[1]) };
    match =
      /^calc\(\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))%\s*([+-])\s*((?:\d+(?:\.\d*)?|\.\d+))px\s*\)$/.exec(
        value,
      );
    if (match) {
      return {
        percentage: Number(match[1]) / 100,
        offsetPx: Number(match[3]) * (match[2] === "-" ? -1 : 1),
      };
    }
    match =
      /^calc\(\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))px\s*([+-])\s*((?:\d+(?:\.\d*)?|\.\d+))%\s*\)$/.exec(
        value,
      );
    if (match) {
      return {
        percentage: (Number(match[3]) * (match[2] === "-" ? -1 : 1)) / 100,
        offsetPx: Number(match[1]),
      };
    }
    return null;
  }

  function parseSvgNaturalSize(
    dataUri: string,
  ): { naturalWidth?: number; naturalHeight?: number } {
    const svgText = decodeSvgDataUri(dataUri);
    if (svgText === null) return {};
    try {
      const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
      if (parsed.querySelector("parsererror") !== null || parsed.documentElement.localName !== "svg") {
        return {};
      }
      const parseDimension = (raw: string | null): number | undefined => {
        if (raw === null) return undefined;
        const match = /^\s*(\d+(?:\.\d*)?|\.\d+)(?:px)?\s*$/.exec(raw);
        if (!match) return undefined;
        const dimension = Number(match[1]);
        return Number.isFinite(dimension) ? dimension : undefined;
      };
      const naturalWidth = parseDimension(parsed.documentElement.getAttribute("width"));
      const naturalHeight = parseDimension(parsed.documentElement.getAttribute("height"));
      return {
        ...(naturalWidth !== undefined ? { naturalWidth } : {}),
        ...(naturalHeight !== undefined ? { naturalHeight } : {}),
      };
    } catch {
      return {};
    }
  }

  function valueForBackgroundLayer(values: string[], index: number, fallback: string): string {
    if (values.length === 0) return fallback;
    return values[index % values.length] ?? fallback;
  }

  function extractFills(style: CSSStyleDeclaration, boxWidth = 0, boxHeight = 0): Paint[] {
    const fills: Paint[] = [];
    const backgroundColor = parseColor(style.backgroundColor);
    if (backgroundColor) {
      fills.push({ type: "solid", color: backgroundColor });
    }
    const backgroundImage = style.backgroundImage;
    if (backgroundImage && backgroundImage !== "none") {
      const layers = splitTopLevel(backgroundImage, ",");
      const backgroundSizes = splitTopLevel(style.backgroundSize || "auto", ",");
      const backgroundRepeats = splitTopLevel(style.backgroundRepeat || "repeat", ",");
      const backgroundPositionsX = splitTopLevel(style.backgroundPositionX || "0%", ",");
      const backgroundPositionsY = splitTopLevel(style.backgroundPositionY || "0%", ",");
      // CSS lists layers top-first; Figma fills are bottom-first, so reverse.
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index];
        if (!layer) {
          continue;
        }
        const rawUrl = parseCssUrl(layer);
        if (rawUrl !== null) {
          const resolved = resolveUrl(rawUrl);
          if (resolved) {
            let assetId: string;
            let naturalSize: { naturalWidth?: number; naturalHeight?: number } = {};
            if (resolved.startsWith("data:")) {
              const commaIndex = resolved.indexOf(",");
              const mediaType =
                resolved.slice(5, commaIndex < 0 ? undefined : commaIndex).split(";")[0] ||
                "image/png";
              if (mediaType.toLowerCase() === "image/svg+xml") {
                naturalSize = parseSvgNaturalSize(resolved);
              }
              assetId = registerInlineAsset(
                "raster-image",
                resolved,
                mediaType,
                naturalSize.naturalWidth,
                naturalSize.naturalHeight,
              );
            } else {
              // The initial kind is only a hint. After download, the engine
              // replaces it with the response Content-Type fact. Path matching
              // must tolerate query and hash suffixes.
              assetId = registerRemoteAsset(
                resolved,
                /\.svg([?#]|$)/i.test(resolved) ? "svg-image" : "raster-image",
              );
            }
            const sizeValue = valueForBackgroundLayer(backgroundSizes, index, "auto");
            // Measured background-repeat fact for each layer. Computed styles
            // normalize values such as "repeat", "no-repeat", "repeat-x",
            // "repeat-y", and "repeat no-repeat".
            const repeatRaw = valueForBackgroundLayer(
              backgroundRepeats,
              index,
              "repeat",
            ).trim();
            const repeatParts = repeatRaw.split(/\s+/);
            const hasUnsupportedRepeat = repeatParts.some(
              (part) => part === "space" || part === "round",
            );
            let repeat: "no-repeat" | "repeat-x" | "repeat-y" | "repeat" | undefined;
            if (hasUnsupportedRepeat) {
              addWarning("unsupported_paint", `background-repeat ${repeatRaw}`);
            } else {
              const rx = repeatParts[0] === "repeat" || repeatParts[0] === "repeat-x";
              const ry =
                repeatParts.length > 1
                  ? repeatParts[1] === "repeat"
                  : repeatParts[0] === "repeat" || repeatParts[0] === "repeat-y";
              repeat = rx && ry ? "repeat" : rx ? "repeat-x" : ry ? "repeat-y" : "no-repeat";
            }
            const positionX = parseBackgroundPositionAxis(
              valueForBackgroundLayer(backgroundPositionsX, index, "0%"),
            );
            const positionY = parseBackgroundPositionAxis(
              valueForBackgroundLayer(backgroundPositionsY, index, "0%"),
            );
            // Background-size lengths and percentages are browser style facts.
            // Resolve percentages to pixels against the current background
            // positioning area (the captured box here), allowing downstream
            // consumers to derive TILE scalingFactor from intrinsic asset size.
            // Without this fact, `background-size: 100%` falls back to tiling at
            // intrinsic size and crops a large SVG to one corner.
            const sizeTokens = sizeValue.trim().split(/\s+/);
            const resolveBackgroundSizeAxis = (token: string | undefined, boxSize: number): number => {
              if (token === undefined) return 0;
              const axis = parseBackgroundPositionAxis(token);
              if (axis === null) return 0;
              const resolvedSize =
                (axis.percentage ?? 0) * boxSize + (axis.offsetPx ?? 0);
              return Number.isFinite(resolvedSize) && resolvedSize > 0 ? resolvedSize : 0;
            };
            const tileW = resolveBackgroundSizeAxis(sizeTokens[0], boxWidth);
            const tileH = resolveBackgroundSizeAxis(sizeTokens[1], boxHeight);
            const isTiling = repeat === undefined || repeat !== "no-repeat";
            const normalizedSize = sizeValue.trim();
            fills.push({
              type: "image",
              assetId,
              // background-size is the browser's concrete sizing fact. A
              // repeated `cover`/`contain` layer still renders one image at
              // that sizing when it already spans the box (Lichess pieces),
              // so repeat alone must not force TILE semantics.
              scaleMode: normalizedSize.includes("cover")
                ? "fill"
                : normalizedSize.includes("contain")
                  ? "fit"
                  : isTiling
                    ? "tile"
                    : "crop",
              ...(repeat !== undefined ? { repeat } : {}),
              ...(positionX !== null && positionY !== null
                ? { backgroundPosition: { x: positionX, y: positionY } }
                : {}),
              ...naturalSize,
              ...(tileW > 0 || tileH > 0
                ? {
                    tileSizePx: {
                      ...(tileW > 0 ? { width: tileW } : {}),
                      ...(tileH > 0 ? { height: tileH } : {}),
                    },
                  }
                : {}),
            });
          } else {
            addWarning("asset_fetch_failed", "unresolvable background url");
          }
          continue;
        }
        const gradient = parseGradient(layer, boxWidth, boxHeight);
        if (gradient) {
          fills.push(gradient);
        } else if (layer.includes("gradient")) {
          addWarning("unsupported_paint", layer.slice(0, 60));
        }
      }
    }

    // CSS mask icons derive shape from mask-image and color from the element
    // background. Handle only the "solid fill + single URL mask" icon pattern:
    // replace the solid color with a tinted mask image asset (tinted by the
    // engine). Preserve other mask usages and emit a warning.
    const maskImage =
      style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image");
    if (maskImage && maskImage !== "none") {
      const maskLayers = splitTopLevel(maskImage, ",");
      const rawUrl = maskLayers.length === 1 ? parseCssUrl(maskLayers[0]!) : null;
      const onlySolid = fills.length === 1 && fills[0]!.type === "solid";
      if (rawUrl !== null && onlySolid) {
        const tintCss = style.backgroundColor;
        let assetId: string | null = null;
        let naturalSize: { naturalWidth?: number; naturalHeight?: number } = {};
        if (rawUrl.startsWith("data:image/svg")) {
          // Decode and tint data URI SVG masks in-page without a download.
          const svgText = decodeSvgDataUri(rawUrl);
          if (svgText !== null) {
            naturalSize = parseSvgNaturalSize(rawUrl);
            assetId = registerInlineAsset(
              "svg-inline",
              tintSvgMarkup(svgText, tintCss),
              "image/svg+xml",
              naturalSize.naturalWidth,
              naturalSize.naturalHeight,
            );
          }
        } else {
          const resolved = resolveUrl(rawUrl);
          if (resolved !== null && !resolved.startsWith("data:")) {
            assetId = registerRemoteAsset(resolved, "svg-image", tintCss);
          }
        }
        if (assetId !== null) {
          const maskSize =
            style.getPropertyValue("mask-size") || style.getPropertyValue("-webkit-mask-size");
          fills.length = 0;
          fills.push({
            type: "image",
            assetId,
            scaleMode: maskSize.includes("cover") ? "fill" : "fit",
            ...naturalSize,
          });
        }
      } else if (fills.length > 0) {
        addWarning("unsupported_paint", `mask-image ${maskImage.slice(0, 40)}`);
      }
    }
    return fills;
  }

  /** Decode a base64 or percent-encoded data:image/svg+xml URI to SVG text. */
  function decodeSvgDataUri(uri: string): string | null {
    try {
      const comma = uri.indexOf(",");
      if (comma < 0) {
        return null;
      }
      const meta = uri.slice(0, comma);
      const payload = uri.slice(comma + 1);
      return meta.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
    } catch {
      return null;
    }
  }

  /**
   * Tint a monochrome icon. A mask's shape is defined by its alpha channel, so
   * all visible pixels receive the tint. Replace currentColor and every fill
   * other than none with the tint, and ensure that the root element has a fill.
   */
  function tintSvgMarkup(svg: string, tint: string): string {
    let out = svg
      .replace(/currentColor/g, tint)
      .replace(/fill="(?!none")[^"]*"/g, `fill="${tint}"`)
      .replace(/fill:\s*(?!none)[^;"'}]+/g, `fill:${tint}`);
    if (!/<svg\b[^>]*\bfill=/.test(out)) {
      out = out.replace(/<svg\b/, `<svg fill="${tint}"`);
    }
    return out;
  }

  function extractBorders(style: CSSStyleDeclaration): Borders | undefined {
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const parsed: Array<{
      widthPx: number;
      style: "solid" | "dashed" | "dotted" | "double" | "none";
      color: RgbaColor;
    } | null> = sides.map((side) => {
      const width = parsePx(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const borderStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
      // Transparent border sides are paint facts (CSS triangles use them to
      // define the geometry). Preserve their alpha instead of dropping the
      // side and making conversion mistake the remaining side for a uniform
      // stroke.
      const color = parseColor(
        style.getPropertyValue(`border-${side.toLowerCase()}-color`),
        true,
      );
      if (width <= 0 || borderStyle === "none" || borderStyle === "hidden" || !color) {
        return null;
      }
      const normalizedStyle =
        borderStyle === "dashed" || borderStyle === "dotted" || borderStyle === "double"
          ? borderStyle
          : "solid";
      return { widthPx: width, style: normalizedStyle, color };
    });
    if (parsed.every((side) => side === null)) {
      return undefined;
    }
    const top = parsed[0] ?? null;
    const right = parsed[1] ?? null;
    const bottom = parsed[2] ?? null;
    const left = parsed[3] ?? null;
    const uniform =
      top !== null &&
      right !== null &&
      bottom !== null &&
      left !== null &&
      parsed.every(
        (side) =>
          side !== null &&
          side.widthPx === top.widthPx &&
          side.style === top.style &&
          side.color.r === top.color.r &&
          side.color.g === top.color.g &&
          side.color.b === top.color.b &&
          side.color.a === top.color.a,
      );
    return {
      ...(top !== null ? { top } : {}),
      ...(right !== null ? { right } : {}),
      ...(bottom !== null ? { bottom } : {}),
      ...(left !== null ? { left } : {}),
      uniform,
    };
  }

  function extractCornerRadii(
    style: CSSStyleDeclaration,
    width: number,
    height: number,
  ): CornerRadii | undefined {
    function radius(value: string): number {
      // Handle "8px" and percentage "50%".
      if (value.endsWith("%")) {
        const pct = Number.parseFloat(value) / 100;
        return Math.min(width, height) * pct;
      }
      return parsePx(value);
    }
    const topLeft = radius(style.borderTopLeftRadius);
    const topRight = radius(style.borderTopRightRadius);
    const bottomRight = radius(style.borderBottomRightRadius);
    const bottomLeft = radius(style.borderBottomLeftRadius);
    if (topLeft <= 0 && topRight <= 0 && bottomRight <= 0 && bottomLeft <= 0) {
      return undefined;
    }
    const maxRadius = Math.min(width, height) / 2;
    return {
      topLeft: Math.min(topLeft, maxRadius),
      topRight: Math.min(topRight, maxRadius),
      bottomRight: Math.min(bottomRight, maxRadius),
      bottomLeft: Math.min(bottomLeft, maxRadius),
    };
  }

  function extractShadows(style: CSSStyleDeclaration): Shadow[] | undefined {
    const raw = style.boxShadow;
    if (!raw || raw === "none") {
      return undefined;
    }
    const shadows: Shadow[] = [];
    for (const layer of splitTopLevel(raw, ",")) {
      const inset = layer.includes("inset");
      const colorMatch =
        /(rgba?\([^)]*\)|color\([^)]*\)|(?:ok)?lab\([^)]*\)|oklch\([^)]*\)|lch\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(
          layer,
        );
      const colorText = colorMatch?.[1];
      const color = colorText !== undefined ? parseColor(colorText) : null;
      if (!color) {
        continue;
      }
      const numericPart = layer
        .replace(colorText ?? "", "")
        .replace("inset", "")
        .trim();
      const lengths = numericPart
        .split(/\s+/)
        .map((token) => Number.parseFloat(token))
        .filter((value) => Number.isFinite(value));
      const [offsetX = 0, offsetY = 0, blurRadius = 0, spreadRadius = 0] = lengths;
      shadows.push({ inset, offsetX, offsetY, blurRadius, spreadRadius, color });
    }
    return shadows.length > 0 ? shadows : undefined;
  }

  /**
   * Resolve a rectangular CSS inset() clip path into page coordinates. The
   * computed style normally resolves viewport units to px; percentages remain
   * relative to the element border box. Unsupported shapes/rounding stay on
   * the legacy path instead of inventing a clip.
   */
  function extractInsetClipBounds(
    style: CSSStyleDeclaration,
    rect: DOMRect,
  ): PageRect | undefined {
    const raw = style.clipPath?.trim();
    const match = raw ? /^inset\((.*)\)$/i.exec(raw) : null;
    const transformKeepsAxesAndScale = (() => {
      if (style.transform === "none") return true;
      try {
        const matrix = new DOMMatrixReadOnly(style.transform);
        const close = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-6;
        return (
          matrix.is2D &&
          close(matrix.a, 1) &&
          close(matrix.b, 0) &&
          close(matrix.c, 0) &&
          close(matrix.d, 1)
        );
      } catch {
        return false;
      }
    })();
    if (!match || /\sround\s/i.test(match[1] ?? "") || !transformKeepsAxesAndScale) {
      return undefined;
    }
    const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > 4) {
      return undefined;
    }
    const resolveLength = (token: string, basis: number): number | null => {
      if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(token)) {
        return (Number.parseFloat(token) / 100) * basis;
      }
      if (!/^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(token)) {
        return null;
      }
      const value = Number.parseFloat(token);
      return Number.isFinite(value) ? value : null;
    };
    const expanded =
      tokens.length === 1
        ? [tokens[0], tokens[0], tokens[0], tokens[0]]
        : tokens.length === 2
          ? [tokens[0], tokens[1], tokens[0], tokens[1]]
          : tokens.length === 3
            ? [tokens[0], tokens[1], tokens[2], tokens[1]]
            : tokens;
    const top = resolveLength(expanded[0] ?? "", rect.height);
    const right = resolveLength(expanded[1] ?? "", rect.width);
    const bottom = resolveLength(expanded[2] ?? "", rect.height);
    const left = resolveLength(expanded[3] ?? "", rect.width);
    if (top === null || right === null || bottom === null || left === null) {
      return undefined;
    }
    const width = rect.width - left - right;
    const height = rect.height - top - bottom;
    if (width <= 0 || height <= 0) {
      return undefined;
    }
    return {
      x: rect.left + scrollX + left,
      y: rect.top + scrollY + top,
      width,
      height,
    };
  }

  function extractLegacyRectClipBounds(
    style: CSSStyleDeclaration,
    rect: DOMRect,
  ): PageRect | undefined {
    if (style.position !== "absolute" && style.position !== "fixed") return undefined;
    const match = /^rect\((.*)\)$/iu.exec(style.clip.trim());
    if (match === null) return undefined;
    if (style.transform !== "none") {
      try {
        const matrix = new DOMMatrixReadOnly(style.transform);
        if (
          !matrix.is2D ||
          Math.abs(matrix.a - 1) > 1e-6 ||
          Math.abs(matrix.b) > 1e-6 ||
          Math.abs(matrix.c) > 1e-6 ||
          Math.abs(matrix.d - 1) > 1e-6
        ) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    const commaSeparated = splitTopLevel(match[1] ?? "", ",").map((token) => token.trim());
    const tokens =
      commaSeparated.length === 4
        ? commaSeparated
        : (match[1] ?? "").trim().split(/\s+/u).filter(Boolean);
    if (tokens.length !== 4) return undefined;
    const readEdge = (token: string, automatic: number): number | null => {
      if (token.toLowerCase() === "auto") return automatic;
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/iu.test(token)) return null;
      const value = Number.parseFloat(token);
      return Number.isFinite(value) ? value : null;
    };
    const top = readEdge(tokens[0] ?? "", 0);
    const right = readEdge(tokens[1] ?? "", rect.width);
    const bottom = readEdge(tokens[2] ?? "", rect.height);
    const left = readEdge(tokens[3] ?? "", 0);
    if (top === null || right === null || bottom === null || left === null) return undefined;
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return undefined;
    return {
      x: rect.left + scrollX + left,
      y: rect.top + scrollY + top,
      width,
      height,
    };
  }

  function extractRectangularClipBounds(
    style: CSSStyleDeclaration,
    rect: DOMRect,
  ): PageRect | undefined {
    return extractInsetClipBounds(style, rect) ?? extractLegacyRectClipBounds(style, rect);
  }

  /** Parse CSS text-shadow (no inset/spread) into shadow layers. */
  function extractTextShadows(style: CSSStyleDeclaration): Shadow[] | undefined {
    const raw = style.textShadow;
    if (!raw || raw === "none") {
      return undefined;
    }
    const shadows: Shadow[] = [];
    for (const layer of splitTopLevel(raw, ",")) {
      const colorMatch =
        /(rgba?\([^)]*\)|color\([^)]*\)|(?:ok)?lab\([^)]*\)|oklch\([^)]*\)|lch\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(
          layer,
        );
      const colorText = colorMatch?.[1];
      const color = colorText !== undefined ? parseColor(colorText) : null;
      if (!color) {
        continue;
      }
      const lengths = layer
        .replace(colorText ?? "", "")
        .trim()
        .split(/\s+/)
        .map((token) => Number.parseFloat(token))
        .filter((value) => Number.isFinite(value));
      const [offsetX = 0, offsetY = 0, blurRadius = 0] = lengths;
      shadows.push({ inset: false, offsetX, offsetY, blurRadius, spreadRadius: 0, color });
    }
    return shadows.length > 0 ? shadows : undefined;
  }

  function extractLayoutHint(style: CSSStyleDeclaration): FlexLayoutHint | undefined {
    const display = style.display;
    if (display !== "flex" && display !== "inline-flex") {
      return undefined;
    }
    const direction = style.flexDirection;
    return {
      display,
      direction:
        direction === "row" ||
        direction === "row-reverse" ||
        direction === "column" ||
        direction === "column-reverse"
          ? direction
          : "row",
      justifyContent: style.justifyContent,
      alignItems: style.alignItems,
      gapRowPx: parsePx(style.rowGap),
      gapColumnPx: parsePx(style.columnGap),
      flexWrap:
        style.flexWrap === "wrap" || style.flexWrap === "wrap-reverse" ? style.flexWrap : "nowrap",
    };
  }

  function extractPadding(style: CSSStyleDeclaration): Padding | undefined {
    const top = parsePx(style.paddingTop);
    const right = parsePx(style.paddingRight);
    const bottom = parsePx(style.paddingBottom);
    const left = parsePx(style.paddingLeft);
    if (top <= 0 && right <= 0 && bottom <= 0 && left <= 0) {
      return undefined;
    }
    return { top, right, bottom, left };
  }

  function extractStackingFacts(
    style: CSSStyleDeclaration,
    stackingParent?: Element | null,
    sourceElement?: Element,
  ): {
    positioned?: true;
    zIndex?: number;
    createsStackingContext?: true;
    layoutOrder?: number;
    topLayer?: true;
  } {
    const facts: {
      positioned?: true;
      zIndex?: number;
      createsStackingContext?: true;
      layoutOrder?: number;
      topLayer?: true;
    } = {};
    const zIndexValue = style.zIndex;
    if (style.position !== "static") {
      facts.positioned = true;
    }
    const parentDisplay =
      stackingParent === undefined || stackingParent === null
        ? ""
        : getComputedStyle(stackingParent).display;
    const zIndexApplies =
      style.position !== "static" ||
      parentDisplay === "flex" ||
      parentDisplay === "inline-flex" ||
      parentDisplay === "grid" ||
      parentDisplay === "inline-grid";
    if (zIndexValue !== "auto" && zIndexApplies) {
      const parsed = Number.parseInt(zIndexValue, 10);
      if (Number.isFinite(parsed)) {
        facts.zIndex = parsed;
      }
    }
    if (
      (parentDisplay === "flex" ||
        parentDisplay === "inline-flex" ||
        parentDisplay === "grid" ||
        parentDisplay === "inline-grid") &&
      style.order !== "0"
    ) {
      const order = Number.parseInt(style.order, 10);
      if (Number.isFinite(order)) facts.layoutOrder = order;
    }
    if (sourceElement !== undefined) {
      try {
        if (sourceElement.matches(":modal, :popover-open")) facts.topLayer = true;
      } catch {
        // Older Chromium builds may not parse one of the top-layer selectors.
      }
    }
    const willChange = (style.willChange || "")
      .split(",")
      .map((value) => value.trim());
    const contain = style.contain || "";
    const containerType = style.getPropertyValue("container-type");
    const isNonNoneProperty = (value: string): boolean => value !== "" && value !== "none";
    const hasIndividualTransform =
      isNonNoneProperty(style.getPropertyValue("rotate")) ||
      isNonNoneProperty(style.getPropertyValue("scale")) ||
      isNonNoneProperty(style.getPropertyValue("translate"));
    const maskBorderSource = style.getPropertyValue("mask-border-source");
    const webkitMaskBorderSource = style.getPropertyValue(
      "-webkit-mask-box-image-source",
    );
    const hasMask =
      maskImageOf(style) !== "none" ||
      isNonNoneProperty(maskBorderSource) ||
      isNonNoneProperty(webkitMaskBorderSource);
    if (
      style.transform !== "none" ||
      hasIndividualTransform ||
      Number.parseFloat(style.opacity) < 1 ||
      style.filter !== "none" ||
      isNonNoneProperty(style.getPropertyValue("backdrop-filter")) ||
      isNonNoneProperty(style.perspective) ||
      style.isolation === "isolate" ||
      (style.mixBlendMode && style.mixBlendMode !== "normal") ||
      willChange.some((property) =>
        [
          "transform",
          "rotate",
          "scale",
          "translate",
          "opacity",
          "filter",
          "backdrop-filter",
          "perspective",
          "clip-path",
          "mask",
        ].includes(property),
      ) ||
      style.position === "fixed" ||
      style.position === "sticky" ||
      (style.clipPath !== "" && style.clipPath !== "none") ||
      hasMask ||
      /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(contain) ||
      (containerType !== "" && containerType !== "normal") ||
      facts.zIndex !== undefined ||
      facts.topLayer === true
    ) {
      facts.createsStackingContext = true;
    }
    return facts;
  }

  /**
   * Bake computed CSS stacking facts into a sibling-local paint rank while we
   * are still in the browser. Capture elements are represented as atomic
   * Figma frames downstream, so positive positioned descendants of a wrapper
   * that does not create a stacking context must lift that wrapper into the
   * ancestor paint band. A real stacking context seals its descendants.
   *
   * This deliberately does not inspect class names, content, or arbitrary
   * geometry margins. Non-overlapping layers still have a deterministic CSS
   * paint order; whether their current rectangles happen to touch is not part
   * of the stacking fact.
   */
  function annotatePaintOrderFacts(rootNode: CaptureElementNode): void {
    const hasPaintContribution = (node: CaptureNode): boolean => {
      if (node.type === "text" || node.type === "image" || node.type === "svg") {
        return true;
      }
      return (
        node.fills.length > 0 ||
        node.borders !== undefined ||
        (node.shadows?.length ?? 0) > 0 ||
        (node.blurPx ?? 0) > 0 ||
        (node.backdropBlurPx ?? 0) > 0 ||
        node.children.some(hasPaintContribution)
      );
    };
    const hasEscapingPositionedBand = (node: CaptureNode): boolean => {
      if (node.positioned === true && (node.zIndex ?? 0) >= 0) {
        return true;
      }
      if (node.type !== "element" || node.createsStackingContext === true) {
        return false;
      }
      return node.children.some(hasEscapingPositionedBand);
    };
    const maxEscapingStackLevel = (node: CaptureNode): number | undefined => {
      if (node.type !== "element") return undefined;
      let max: number | undefined;
      for (const child of node.children) {
        let own: number | undefined;
        if (child.zIndex !== undefined) {
          own = child.zIndex;
        } else if (child.createsStackingContext === true) {
          own = child.positioned === true ? 0 : undefined;
        } else if (child.type === "element") {
          own = maxEscapingStackLevel(child);
          if (child.positioned === true) own = Math.max(0, own ?? 0);
        } else if (child.positioned === true) {
          own = 0;
        }
        if (own !== undefined && own >= 0 && (max === undefined || own > max)) {
          max = own;
        }
      }
      return max;
    };
    const ownStackLevel = (node: CaptureNode): number | undefined => {
      if (node.zIndex !== undefined) return node.zIndex;
      if (node.createsStackingContext === true || node.positioned === true) return 0;
      return undefined;
    };
    const canExposeStackingDescendant = (node: CaptureElementNode): boolean =>
      node.createsStackingContext !== true &&
      node.zIndex === undefined &&
      node.topLayer !== true &&
      node.opacity >= 0.999 &&
      node.clipsContent !== true &&
      node.clipAxes === undefined &&
      node.clipBounds === undefined &&
      node.mixBlendMode === undefined &&
      (node.rotationDegrees === undefined || node.rotationDegrees === 0) &&
      (node.blurPx ?? 0) === 0 &&
      (node.backdropBlurPx ?? 0) === 0 &&
      node.fragmentRects === undefined;
    const boundsOverlap = (a: CaptureNode["bounds"], b: CaptureNode["bounds"]): boolean =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
    const setAncestorPaintOrder = (
      node: CaptureNode,
      ancestorId: string,
      order: number,
    ): void => {
      const retained = (node.ancestorPaintOrders ?? []).filter(
        (fact) => fact.ancestorId !== ancestorId,
      );
      retained.push({ ancestorId, order });
      node.ancestorPaintOrders = retained;
    };
    const stackLevel = (node: CaptureNode): number | undefined => {
      if (node.zIndex !== undefined) {
        return node.zIndex;
      }
      if (node.createsStackingContext === true) {
        return 0;
      }
      const descendantLevel = maxEscapingStackLevel(node);
      if (node.positioned === true) {
        return descendantLevel === undefined ? 0 : Math.max(0, descendantLevel);
      }
      return descendantLevel;
    };
    const visit = (parent: CaptureElementNode): void => {
      const siblingsHavePaint = parent.children.some(hasPaintContribution);
      const needsStackSort =
        siblingsHavePaint &&
        parent.children.some(
          (child) =>
            child.zIndex !== undefined ||
            child.positioned === true ||
            child.createsStackingContext === true ||
            child.layoutOrder !== undefined ||
            child.topLayer === true ||
            (child.type === "element" &&
              child.children.some(hasEscapingPositionedBand)),
        );
      const ordered = parent.children.map((child, index) => ({
        child,
        index,
        level: needsStackSort ? stackLevel(child) : undefined,
      }));
      ordered.sort((left, right) => {
        if (left.child.topLayer !== right.child.topLayer) {
          return left.child.topLayer === true ? 1 : -1;
        }
        const leftGroup =
          left.level === undefined ? 0 : left.level < 0 ? -1 : 1;
        const rightGroup =
          right.level === undefined ? 0 : right.level < 0 ? -1 : 1;
        if (leftGroup !== rightGroup) return leftGroup - rightGroup;
        if (leftGroup !== 0 && left.level !== right.level) {
          return (left.level ?? 0) - (right.level ?? 0);
        }
        const orderDelta =
          (left.child.layoutOrder ?? 0) - (right.child.layoutOrder ?? 0);
        if (orderDelta !== 0) return orderDelta;
        return left.index - right.index;
      });
      ordered.forEach((entry, paintOrder) => {
        entry.child.paintOrder = paintOrder;
      });

      // A Figma frame is atomic, while a positive-z descendant of a plain DOM
      // wrapper participates directly in an ancestor stacking context. Record
      // that flattened ancestor band here, where all computed stacking and
      // clipping facts are still available. Conversion may then split the
      // wrapper without erasing or reconstructing browser facts.
      const directPeersByChild = new Map<CaptureNode, CaptureNode[]>();
      for (const child of parent.children) {
        directPeersByChild.set(
          child,
          parent.children.filter((peer) => peer !== child),
        );
      }
      const escaping: Array<{ node: CaptureNode; sequence: number }> = [];
      const collectEscaping = (
        wrapper: CaptureElementNode,
        peers: CaptureNode[],
        directIndex: number,
        nestedSequence: { value: number },
      ): void => {
        if (!canExposeStackingDescendant(wrapper)) return;
        for (const child of wrapper.children) {
          const overlapsExternalPaint = peers.some(
            (peer) => hasPaintContribution(peer) && boundsOverlap(child.bounds, peer.bounds),
          );
          if (
            child.positioned === true &&
            (child.zIndex ?? 0) >= 0 &&
            overlapsExternalPaint
          ) {
            nestedSequence.value += 1;
            escaping.push({
              node: child,
              sequence: directIndex * 1_000_000 + nestedSequence.value,
            });
            continue;
          }
          if (child.type === "element") {
            collectEscaping(child, peers, directIndex, nestedSequence);
          }
        }
      };
      parent.children.forEach((child, directIndex) => {
        if (child.type === "element") {
          collectEscaping(
            child,
            directPeersByChild.get(child) ?? [],
            directIndex,
            { value: 0 },
          );
        }
      });
      if (escaping.length > 0) {
        const participants = [
          ...parent.children.map((node, directIndex) => ({
            node,
            sequence: directIndex * 1_000_000,
            level: ownStackLevel(node),
            layoutOrder: node.layoutOrder ?? 0,
          })),
          ...escaping.map(({ node, sequence }) => ({
            node,
            sequence,
            level: ownStackLevel(node),
            layoutOrder: 0,
          })),
        ];
        participants.sort((left, right) => {
          if (left.node.topLayer !== right.node.topLayer) {
            return left.node.topLayer === true ? 1 : -1;
          }
          const leftGroup =
            left.level === undefined ? 0 : left.level < 0 ? -1 : 1;
          const rightGroup =
            right.level === undefined ? 0 : right.level < 0 ? -1 : 1;
          if (leftGroup !== rightGroup) return leftGroup - rightGroup;
          if (leftGroup !== 0 && left.level !== right.level) {
            return (left.level ?? 0) - (right.level ?? 0);
          }
          const layoutDelta = left.layoutOrder - right.layoutOrder;
          if (layoutDelta !== 0) return layoutDelta;
          return left.sequence - right.sequence;
        });
        participants.forEach((participant, order) => {
          setAncestorPaintOrder(participant.node, parent.id, order);
        });
      }
      for (const child of parent.children) {
        if (child.type === "element") visit(child);
      }
    };
    visit(rootNode);
  }

  interface Matrix2d {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }

  function parseMatrix2d(transform: string | null | undefined): Matrix2d | null {
    if (!transform || transform === "none") {
      return null;
    }
    const match = /^matrix\(\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*,\s*([-\d.e+]+)\s*\)$/.exec(
      transform,
    );
    if (!match) {
      return null;
    }
    const values = match.slice(1).map(Number);
    if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
      return null;
    }
    return {
      a: values[0]!,
      b: values[1]!,
      c: values[2]!,
      d: values[3]!,
      e: values[4]!,
      f: values[5]!,
    };
  }

  function extractRotation(style: CSSStyleDeclaration): number | undefined {
    const transform = style.transform;
    if (!transform || transform === "none") {
      return undefined;
    }
    const matrix = parseMatrix2d(transform);
    if (!matrix) {
      if (transform.startsWith("matrix3d")) {
        addWarning("unsupported_transform", "matrix3d");
      }
      return undefined;
    }
    const degrees = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
    if (Math.abs(degrees) < 0.01) {
      return undefined;
    }
    return degrees;
  }

  function parseTransformOrigin(
    style: CSSStyleDeclaration,
    width: number,
    height: number,
  ): { x: number; y: number } | null {
    const tokens = style.transformOrigin.trim().split(/\s+/);
    const parseAxis = (
      token: string | undefined,
      size: number,
      axis: "x" | "y",
    ): number | null => {
      if (token === undefined) return size / 2;
      if (token === "left" || token === "top") return 0;
      if (token === "center") return size / 2;
      if (token === "right" || token === "bottom") return size;
      if (token.endsWith("px")) {
        const value = Number.parseFloat(token);
        return Number.isFinite(value) ? value : null;
      }
      if (token.endsWith("%")) {
        const value = Number.parseFloat(token);
        return Number.isFinite(value) ? (value / 100) * size : null;
      }
      // Bare numbers (including "0") are CSS lengths in px for transform-origin.
      const bare = Number.parseFloat(token);
      if (Number.isFinite(bare) && /^-?\d+(\.\d+)?$/.test(token)) {
        return bare;
      }
      void axis;
      return null;
    };
    const x = parseAxis(tokens[0], width, "x");
    const y = parseAxis(tokens[1], height, "y");
    return x === null || y === null ? null : { x, y };
  }

  function applyAxisAlignedTransform(
    bounds: PageRect,
    style: CSSStyleDeclaration,
  ): PageRect | null | undefined {
    const transform = style.transform;
    if (!transform || transform === "none") {
      return bounds;
    }
    const matrix = parseMatrix2d(transform);
    if (!matrix || Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001) {
      return undefined;
    }
    const origin = parseTransformOrigin(style, bounds.width, bounds.height);
    if (origin === null) {
      return undefined;
    }
    const left = matrix.a * (0 - origin.x) + matrix.e + origin.x;
    const right = matrix.a * (bounds.width - origin.x) + matrix.e + origin.x;
    const top = matrix.d * (0 - origin.y) + matrix.f + origin.y;
    const bottom = matrix.d * (bounds.height - origin.y) + matrix.f + origin.y;
    const width = Math.abs(right - left);
    const height = Math.abs(bottom - top);
    if (width < 0.01 || height < 0.01) {
      return null;
    }
    return {
      x: bounds.x + Math.min(left, right),
      y: bounds.y + Math.min(top, bottom),
      width,
      height,
    };
  }

  function applyStructurallyRepresentablePseudoTransform(
    bounds: PageRect,
    style: CSSStyleDeclaration,
  ): PageRect | null | undefined {
    const axisAligned = applyAxisAlignedTransform(bounds, style);
    if (axisAligned !== undefined) {
      return axisAligned;
    }
    const matrix = parseMatrix2d(style.transform);
    if (matrix === null) {
      return undefined;
    }
    const scaleX = Math.hypot(matrix.a, matrix.b);
    const scaleY = Math.hypot(matrix.c, matrix.d);
    const dot = matrix.a * matrix.c + matrix.b * matrix.d;
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (
      Math.abs(scaleX - 1) > 0.0001 ||
      Math.abs(scaleY - 1) > 0.0001 ||
      Math.abs(dot) > 0.0001 ||
      determinant <= 0
    ) {
      return undefined;
    }
    const transformed = transformedBorderBoxRect(
      new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height),
      style,
    );
    if (transformed === null) {
      return undefined;
    }
    if (transformed.width < 0.01 || transformed.height < 0.01) {
      return null;
    }
    return {
      x: transformed.left,
      y: transformed.top,
      width: transformed.width,
      height: transformed.height,
    };
  }

  function extractTextStyle(style: CSSStyleDeclaration): TextStyle {
    const fontSizePx = parsePx(style.fontSize);
    let lineHeightPx = parsePx(style.lineHeight);
    if (lineHeightPx <= 0) {
      lineHeightPx = Math.round(fontSizePx * 1.2 * 100) / 100;
    }
    const stack = style.fontFamily;
    const firstFamily = splitTopLevel(stack, ",")[0]?.replace(/["']/g, "").trim() || "sans-serif";
    const letterSpacing = style.letterSpacing === "normal" ? 0 : parsePx(style.letterSpacing);
    const align = style.textAlign;
    const decoration = style.textDecorationLine;
    const transform = style.textTransform;
    return {
      fontFamily: firstFamily,
      fontFamilyStack: stack,
      fontSizePx,
      fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
      italic: style.fontStyle === "italic" || style.fontStyle.startsWith("oblique"),
      lineHeightPx,
      letterSpacingPx: letterSpacing,
      color: parseColor(style.color, true) ?? { r: 0, g: 0, b: 0, a: 1 },
      // start/end are logical values and require the measured direction fact
      // (start means right in RTL). Explicit left/right/center/justify values
      // are physical and independent of direction.
      textAlign:
        align === "left" || align === "center" || align === "right" || align === "justify"
          ? align
          : align === "end"
            ? style.direction === "rtl"
              ? "left"
              : "right"
            : style.direction === "rtl"
              ? "right"
              : "left",
      textDecoration: decoration.includes("underline")
        ? "underline"
        : decoration.includes("line-through")
          ? "line-through"
          : "none",
      textTransform:
        transform === "uppercase" || transform === "lowercase" || transform === "capitalize"
          ? transform
          : "none",
    };
  }

  function toPageRect(rect: DOMRect): PageRect {
    return {
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Whether an overflow value clips content to the box. hidden and clip
   * obviously clip; auto and scroll create scroll containers whose content is
   * also visually clipped to the scrollport. Only visible does not clip.
   */
  function clipsOverflow(value: string): boolean {
    return value === "hidden" || value === "clip" || value === "auto" || value === "scroll";
  }

  /**
   * An absolutely positioned descendant is not clipped by an overflow
   * ancestor that sits between it and its containing block. offsetParent is
   * Chromium's resolved containing-block fact for these ordinary absolute
   * boxes. This matters for zero-height navigation lists (CSS Zen Garden):
   * their visible CTA is positioned against the outer nav and intentionally
   * escapes the intervening `overflow:hidden` ul.
   */
  function hasVisiblePositionedClipEscape(element: Element, rect: DOMRect): boolean {
    if (rect.width > 0 && rect.height > 0) return false;
    const candidates = element.querySelectorAll<HTMLElement>("*");
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates.item(index);
      if (candidate === null) continue;
      const candidateStyle = getComputedStyle(candidate);
      if (candidateStyle.position !== "absolute") continue;
      const candidateRect = candidate.getBoundingClientRect();
      if (candidateRect.width <= 0 || candidateRect.height <= 0) continue;
      const containingBlock = candidate.offsetParent;
      if (
        containingBlock !== null &&
        containingBlock !== element &&
        !element.contains(containingBlock)
      ) {
        return true;
      }
    }
    return false;
  }

  /** True when any descendant has a positive painted box (not visibility/opacity hidden). */
  function hasVisiblePaintedDescendant(element: Element): boolean {
    const candidates = element.querySelectorAll<Element>("*");
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates.item(index);
      if (candidate === null) continue;
      const candidateRect = candidate.getBoundingClientRect();
      if (candidateRect.width <= 1 || candidateRect.height <= 1) continue;
      const candidateStyle = getComputedStyle(candidate);
      if (
        candidateStyle.display === "none" ||
        candidateStyle.visibility === "hidden" ||
        candidateStyle.visibility === "collapse" ||
        Number.parseFloat(candidateStyle.opacity) === 0
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  function layerName(element: Element): string {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    let className = "";
    if (typeof element.className === "string" && element.className.trim().length > 0) {
      const first = element.className.trim().split(/\s+/)[0];
      if (first && first.length <= 32) {
        className = `.${first}`;
      }
    }
    return `${tag}${id}${className}`;
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  const skippedTags = new Set([
    "SCRIPT",
    "STYLE",
    "META",
    "LINK",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "TITLE",
    "BASE",
    "SOURCE",
    "TRACK",
    "MAP",
    "AREA",
    "DATALIST",
  ]);

  function directOverflowChildContributesOnPage(
    element: Element,
    style: CSSStyleDeclaration,
  ): boolean {
    if (clipsOverflow(style.overflowX) && clipsOverflow(style.overflowY)) {
      return false;
    }

    const composedChildren = (parent: Element): Element[] => {
      if (parent instanceof HTMLSlotElement) {
        const assigned = parent.assignedElements({ flatten: true });
        return assigned.length > 0 ? assigned : Array.from(parent.children);
      }
      const shadowRoot = (parent as HTMLElement).shadowRoot;
      return Array.from(shadowRoot?.children ?? parent.children);
    };
    const pending = composedChildren(element);
    let visited = 0;
    while (pending.length > 0 && visited < 250) {
      const child = pending.shift();
      if (child === undefined) continue;
      visited += 1;
      const childStyle = getComputedStyle(child);
      if (
        childStyle.display === "none" ||
        childStyle.visibility === "hidden" ||
        childStyle.visibility === "collapse" ||
        Number.parseFloat(childStyle.opacity) === 0
      ) {
        continue;
      }
      const childRect = child.getBoundingClientRect();
      const left = childRect.left + scrollX;
      const top = childRect.top + scrollY;
      if (
        childRect.width > 0 &&
        childRect.height > 0 &&
        left < capturePageWidth &&
        left + childRect.width > 0 &&
        top < capturePageHeight &&
        top + childRect.height > 0
      ) {
        return true;
      }
      if (!clipsOverflow(childStyle.overflowX) || !clipsOverflow(childStyle.overflowY)) {
        pending.push(...composedChildren(child));
      }
    }
    return false;
  }

  function isRenderable(element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (skippedTags.has(element.tagName)) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    if (Number.parseFloat(style.opacity) === 0) {
      return false;
    }
    // Browser-rendered visibility fact. checkVisibility() detects hidden states
    // that computed style misses, such as content-visibility:hidden inside a
    // collapsed <details>, where display/visibility remain visible and rects
    // still expose layout coordinates. Exclude display:contents because the
    // element itself has no box even when its subtree is visible.
    // Offscreen content skipped by content-visibility:auto is not hidden by
    // default and remains unaffected.
    if (
      style.display !== "contents" &&
      typeof element.checkVisibility === "function" &&
      !element.checkVisibility()
    ) {
      return false;
    }
    if (rect.width <= 0 && rect.height <= 0) {
      // Zero-size containers can still have visible overflow children.
      // overflow:hidden hosts are usually skipped, but NatGeo's
      // BgImagePromo background collapses the BackgroundImage wrapper to
      // 0×0 while absolute-filled image spans still paint at full size —
      // keep those hosts so descendants stay in the tree.
      if (element.childElementCount === 0) {
        return false;
      }
      if (!clipsOverflow(style.overflowX) && !clipsOverflow(style.overflowY)) {
        return true;
      }
      return hasVisiblePaintedDescendant(element);
    }
    // Ignore fully off-page content (e.g. sr-only offscreen).
    if (
      (rect.right + scrollX < -1 || rect.bottom + scrollY < -1) &&
      !directOverflowChildContributesOnPage(element, style)
    ) {
      return false;
    }
    // Screen-reader-only content: visually hidden via clip/clip-path.
    // inset(50%/100%) collapses the paint area to empty regardless of the
    // layout box size; capturing it would either duplicate text or (worse)
    // promote the host into a clipped-subtree screenshot tile.
    if (
      style.clipPath === "inset(50%)" ||
      style.clipPath === "inset(100%)"
    ) {
      return false;
    }
    if (rect.width <= 1 && rect.height <= 1) {
      if (
        style.clip !== "auto" &&
        /rect\(\s*0(?:px)?[\s,]+0(?:px)?/.test(style.clip)
      ) {
        return false;
      }
      if (style.overflow === "hidden" && element.childElementCount === 0) {
        return false;
      }
    }
    return true;
  }

  function displayContentsRenderedRect(element: Element): DOMRect | null {
    const range = document.createRange();
    try {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!hasNonCollapsibleContent(node.nodeValue ?? "")) continue;
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0.01 && rect.height > 0.01) rects.push(rect);
        }
      }
      for (const child of Array.from(element.children)) {
        const rect = child.getBoundingClientRect();
        if (rect.width > 0.01 && rect.height > 0.01) rects.push(rect);
      }
      if (rects.length === 0) return null;
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    } catch {
      return null;
    } finally {
      range.detach();
    }
  }

  const inlineDisplays = new Set(["inline", "inline-block", "inline-flex", "contents", "ruby"]);

  function hasVisibleGeneratedPseudo(element: Element): boolean {
    for (const pseudo of ["before", "after"] as const) {
      try {
        const style = getComputedStyle(element, `::${pseudo}`);
        if (
          style.content &&
          style.content !== "none" &&
          style.content !== "normal" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity) !== 0
        ) {
          return true;
        }
      } catch {
        // Ignore an inaccessible pseudo style and continue with normal inline handling.
      }
    }
    return false;
  }

  function isInlineTextElement(element: Element, style: CSSStyleDeclaration): boolean {
    // SVG elements report lowercase tagName ("svg", not "SVG"), so normalize
    // before comparing; otherwise inline-display SVG icons are silently
    // swallowed by the text-run path and vanish from the capture.
    const tag = element.tagName.toUpperCase();
    if (
      tag === "IMG" ||
      tag === "SVG" ||
      tag === "VIDEO" ||
      tag === "CANVAS" ||
      tag === "IFRAME" ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      tag === "BR"
    ) {
      return false;
    }
    if (!inlineDisplays.has(style.display)) {
      return false;
    }
    // inline-block/inline-flex are atomic inline-level boxes: their measured
    // width, margins and baseline participate in layout independently of the
    // text they contain. Flattening them into a Range loses that browser box
    // (GOV.UK's multi-column footer is a representative failure).
    if (style.display === "inline-block" || style.display === "inline-flex") {
      return false;
    }
    // Ordinary inline descendants can also carry spacing that changes the
    // rendered run. Keep those as boxes instead of silently deleting their
    // margin/padding while merging their text into the parent.
    const inlineSpacing = [
      style.marginTop,
      style.marginRight,
      style.marginBottom,
      style.marginLeft,
      style.paddingTop,
      style.paddingRight,
      style.paddingBottom,
      style.paddingLeft,
    ];
    if (
      inlineSpacing.some((value) => {
        const numeric = Number.parseFloat(value);
        return Number.isFinite(numeric) && Math.abs(numeric) > 0.0001;
      })
    ) {
      return false;
    }
    // Positioning creates an independent paint/order context for animated
    // counters and overlays. Merging those descendants into the parent Range
    // pulls hidden/absolute animation frames into visible text runs.
    if (style.position !== "static") {
      return false;
    }
    // Generated pseudo content is independently painted by the browser. If
    // this inline host is flattened into its parent text run, empty icon
    // hosts disappear before walkPseudoElement can capture their glyph.
    if (hasVisibleGeneratedPseudo(element)) {
      return false;
    }
    // Inline elements with their own backgrounds/borders should become frames.
    if (parseColor(style.backgroundColor) || style.backgroundImage !== "none") {
      return false;
    }
    // box-shadow is also owned paint. Sites often use an unblurred offset
    // shadow as a border line (for example, box-shadow: -2px 0 0 on an MDN
    // table-of-contents link). Folding the element into a text run would
    // silently drop that line.
    if (style.boxShadow !== "none" && style.boxShadow !== "") {
      return false;
    }
    // Real borders follow the same rule (the earlier comment claimed this
    // behavior, but the implementation did not previously check them).
    if (
      (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none") ||
      (parseFloat(style.borderRightWidth) > 0 && style.borderRightStyle !== "none") ||
      (parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== "none") ||
      (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== "none")
    ) {
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Text run collection
  // -------------------------------------------------------------------------

  interface TextRunPiece {
    node: Text;
    text: string;
    style: TextStyle;
  }

  const cssCollapsibleWhitespacePattern = /[ \t\n\f\r]+/g;
  const cssCollapsibleWhitespaceStartPattern = /^[ \t\n\f\r]+/;
  const cssCollapsibleWhitespaceEndPattern = /[ \t\n\f\r]+$/;

  function isCssCollapsibleWhitespace(value: string): boolean {
    return value.length === 1 && /[ \t\n\f\r]/.test(value);
  }

  function hasNonCollapsibleContent(value: string): boolean {
    return /[^ \t\n\f\r]/.test(value);
  }

  function trimCssCollapsibleWhitespaceStart(value: string): string {
    return value.replace(cssCollapsibleWhitespaceStartPattern, "");
  }

  function trimCssCollapsibleWhitespaceEnd(value: string): string {
    return value.replace(cssCollapsibleWhitespaceEndPattern, "");
  }

  function collapseWhitespace(input: string, preserve: boolean): string {
    if (preserve) {
      return input;
    }
    return input.replace(cssCollapsibleWhitespacePattern, " ");
  }

  function hasRenderedBoundaryWhitespace(
    piece: TextRunPiece,
    boundary: "start" | "end",
  ): boolean {
    const raw = piece.node.nodeValue ?? "";
    const match =
      boundary === "start"
        ? cssCollapsibleWhitespaceStartPattern.exec(raw)
        : cssCollapsibleWhitespaceEndPattern.exec(raw);
    const whitespace = match?.[0];
    if (!whitespace) return false;
    const start = boundary === "start" ? 0 : raw.length - whitespace.length;
    const range = document.createRange();
    try {
      range.setStart(piece.node, start);
      range.setEnd(piece.node, start + whitespace.length);
      const rects = range.getClientRects();
      for (let index = 0; index < rects.length; index += 1) {
        const rect = rects.item(index);
        if (rect && rect.width > 0.01 && rect.height > 0.01) return true;
      }
    } catch {
      return false;
    } finally {
      range.detach();
    }
    return false;
  }

  const textFontFallbackAssetIds = new Map<string, string>();
  const maxTextFontFallbackAssets = 1024;
  const maxTextFontFallbackPixels = 32_000_000;
  const maxTextFontFallbackCharacters = 50_000;
  const maxTextFontFallbackGlyphChecks = 10_000;
  const maxTextFontFallbackWorkMs = 750;
  let textFontFallbackPixels = 0;
  let textFontFallbackCharacters = 0;
  let textFontFallbackGlyphChecks = 0;
  let textFontFallbackWorkStartedAt: number | undefined;
  let textFontFallbackBudgetWarned = false;

  function textFontFallbackTimeExceeded(): boolean {
    textFontFallbackWorkStartedAt ??= performance.now();
    return performance.now() - textFontFallbackWorkStartedAt > maxTextFontFallbackWorkMs;
  }

  function warnTextFontFallbackBudget(): void {
    if (textFontFallbackBudgetWarned) return;
    textFontFallbackBudgetWarned = true;
    addWarning("unsupported_paint", "authored webfont pixel fallback budget exhausted");
  }

  function normalizedCapturedFontFamily(value: string): string {
    const trimmed = value.trim();
    if (
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ) {
      return trimmed.slice(1, -1).trim().toLocaleLowerCase();
    }
    return trimmed.toLocaleLowerCase();
  }

  /** Browser fact: this family is backed by a loaded authored FontFace. */
  function authoredFontFamilyIsLoaded(family: string): boolean {
    const wanted = normalizedCapturedFontFamily(family);
    if (wanted.length === 0) return false;
    let loaded = false;
    try {
      document.fonts.forEach((fontFace) => {
        if (
          fontFace.status === "loaded" &&
          normalizedCapturedFontFamily(fontFace.family) === wanted
        ) {
          loaded = true;
        }
      });
    } catch {
      return false;
    }
    return loaded;
  }

  function authoredFontFamilyIsDeclared(family: string): boolean {
    const wanted = normalizedCapturedFontFamily(family);
    if (wanted.length === 0) return false;
    let declared = false;
    try {
      document.fonts.forEach((fontFace) => {
        if (normalizedCapturedFontFamily(fontFace.family) === wanted) {
          declared = true;
        }
      });
    } catch {
      return false;
    }
    return declared;
  }

  const genericCapturedFontFamilies = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "emoji",
    "math",
    "fangsong",
  ]);

  function isGenericFontFamily(family: string): boolean {
    return genericCapturedFontFamilies.has(normalizedCapturedFontFamily(family));
  }

  /** Browser fact: an authored face exists, but none of its declarations loaded. */
  function authoredFontFamilyFailed(family: string): boolean {
    const wanted = normalizedCapturedFontFamily(family);
    if (wanted.length === 0) return false;
    let declared = false;
    let loaded = false;
    try {
      document.fonts.forEach((fontFace) => {
        if (normalizedCapturedFontFamily(fontFace.family) !== wanted) return;
        declared = true;
        if (fontFace.status === "loaded") loaded = true;
      });
    } catch {
      return false;
    }
    return declared && !loaded;
  }

  function transformCapturedText(text: string, transform: TextStyle["textTransform"]): string {
    if (transform === "uppercase") return text.toUpperCase();
    if (transform === "lowercase") return text.toLowerCase();
    if (transform === "capitalize") {
      return text.replace(/\b\p{L}/gu, (character) => character.toUpperCase());
    }
    return text;
  }

  function canvasFontFromComputedStyle(style: CSSStyleDeclaration): string {
    // CSSOM returns an empty `font` shorthand when non-shorthand longhands
    // such as font-variation-settings participate. Assigning that empty value
    // leaves Canvas at its 10px default. These four computed longhands form a
    // valid Canvas font string; the remaining supported facts are assigned on
    // CanvasTextDrawingStyles below.
    return style.font.trim().length > 0
      ? style.font
      : `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  }

  // CanvasFontStretch accepts keywords, while computed CSS commonly returns
  // percentages. Map that measured percentage to the nearest CSS keyword so
  // Canvas does not reject the assignment and discard the glyph fallback.
  function canvasFontStretchFromCss(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (
      trimmed === "ultra-condensed" ||
      trimmed === "extra-condensed" ||
      trimmed === "condensed" ||
      trimmed === "semi-condensed" ||
      trimmed === "normal" ||
      trimmed === "semi-expanded" ||
      trimmed === "expanded" ||
      trimmed === "extra-expanded" ||
      trimmed === "ultra-expanded"
    ) {
      return trimmed;
    }
    const percentMatch = /^([\d.]+)\s*%$/.exec(trimmed);
    if (percentMatch) {
      const percent = Number.parseFloat(percentMatch[1]!);
      if (Number.isFinite(percent)) {
        const table: Array<{ percent: number; keyword: string }> = [
          { percent: 50, keyword: "ultra-condensed" },
          { percent: 62.5, keyword: "extra-condensed" },
          { percent: 75, keyword: "condensed" },
          { percent: 87.5, keyword: "semi-condensed" },
          { percent: 100, keyword: "normal" },
          { percent: 112.5, keyword: "semi-expanded" },
          { percent: 125, keyword: "expanded" },
          { percent: 150, keyword: "extra-expanded" },
          { percent: 200, keyword: "ultra-expanded" },
        ];
        let best = "normal";
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const entry of table) {
          const distance = Math.abs(entry.percent - percent);
          if (distance < bestDistance) {
            best = entry.keyword;
            bestDistance = distance;
          }
        }
        return best;
      }
    }
    return "normal";
  }

  /**
   * Preserve authored webfont pixels without sacrificing editability. The
   * target decides at runtime whether its exact family is loadable; this PNG
   * is only the failure branch. It is deferred behind page imagery in the
   * Node-side byte budget so typography can never evict source photos.
   */
  const renderedFallbackGlyphCache = new Map<string, boolean>();

  function browserRenderedGlyphUsesFallbackFont(
    character: string,
    sourceStyle: CSSStyleDeclaration,
    authoredFamily: string,
  ): boolean {
    if (!hasNonCollapsibleContent(character)) return false;
    const key = JSON.stringify([
      character,
      authoredFamily,
      sourceStyle.fontStyle,
      sourceStyle.fontWeight,
      sourceStyle.fontStretch,
    ]);
    const cached = renderedFallbackGlyphCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const render = (family: string): { width: number; pixels: Uint8ClampedArray } => {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 80;
        const context = canvas.getContext("2d");
        if (context === null) return { width: -1, pixels: new Uint8ClampedArray() };
        context.font = `${sourceStyle.fontStyle} ${sourceStyle.fontWeight} 48px ${family}`;
        context.fillStyle = "#000";
        context.textBaseline = "alphabetic";
        context.fillText(character, 4, 60);
        return {
          width: context.measureText(character).width,
          pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const authored = render(JSON.stringify(authoredFamily));
      const generic = render("sans-serif");
      let equal =
        authored.width >= 0 &&
        Math.abs(authored.width - generic.width) <= 0.01 &&
        authored.pixels.length === generic.pixels.length;
      for (let index = 0; equal && index < authored.pixels.length; index += 1) {
        if (authored.pixels[index] !== generic.pixels[index]) equal = false;
      }
      renderedFallbackGlyphCache.set(key, equal);
      return equal;
    } catch {
      renderedFallbackGlyphCache.set(key, false);
      return false;
    }
  }

  function browserRenderedTextUsesFallbackFont(pieces: TextRunPiece[]): boolean {
    for (const piece of pieces) {
      if (!authoredFontFamilyIsLoaded(piece.style.fontFamily)) continue;
      const sourceElement = piece.node.parentElement;
      if (sourceElement === null) continue;
      const sourceStyle = getComputedStyle(sourceElement);
      for (const character of Array.from(piece.text)) {
        textFontFallbackGlyphChecks += 1;
        if (
          textFontFallbackGlyphChecks > maxTextFontFallbackGlyphChecks ||
          textFontFallbackTimeExceeded()
        ) {
          // The bitmap already exists. On budget exhaustion prefer its closed
          // browser pixels over a potentially missing delegated glyph in the
          // target runtime.
          warnTextFontFallbackBudget();
          return true;
        }
        if (
          browserRenderedGlyphUsesFallbackFont(character, sourceStyle, piece.style.fontFamily)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function isPrivateUseCodePoint(character: string): boolean {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
        (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
        (codePoint >= 0x100000 && codePoint <= 0x10fffd))
    );
  }

  /**
   * Browser fact: Private Use characters have no portable Unicode glyph.
   * When their authored face is loaded, the visible shape belongs to that
   * site-provided font and cannot be reconstructed by a target font lookup.
   */
  function browserRenderedTextUsesAuthoredPrivateUseFont(pieces: TextRunPiece[]): boolean {
    return pieces.some(
      (piece) =>
        authoredFontFamilyIsLoaded(piece.style.fontFamily) &&
        Array.from(piece.text).some(isPrivateUseCodePoint),
    );
  }

  function browserRenderedTextUsesFailedAuthoredFont(pieces: TextRunPiece[]): boolean {
    return pieces.some((piece) => authoredFontFamilyFailed(piece.style.fontFamily));
  }

  function rasterizeDomTextFontFallback(
    pieces: TextRunPiece[],
    segments: TextSegment[],
    text: string,
    style: TextStyle,
    bounds: PageRect,
    measuredLines: TextLineBox[] | undefined,
  ): string | undefined {
    if (
      !captureTextFallbacks ||
      pieces.length === 0 ||
      segments.length === 0 ||
      text.length === 0 ||
      text.length > 5000
    ) {
      return undefined;
    }
    if (
      textFontFallbackCharacters + text.length > maxTextFontFallbackCharacters ||
      textFontFallbackTimeExceeded()
    ) {
      warnTextFontFallbackBudget();
      return undefined;
    }
    // Keep editable decoration in the canonical TEXT node. Canvas fillText
    // cannot reproduce underline/strike placement or mixed decoration ranges.
    if (segments.some((segment) => segment.style.textDecoration !== "none")) {
      return undefined;
    }
    // Only a page-declared @font-face needs browser pixels. This is a browser
    // fact, unlike a hard-coded family whitelist: a site may publish its own
    // face under names such as Inter or Roboto, while ordinary local/system
    // text has no FontFace declaration and remains editable. Failed authored
    // declarations are included because the browser-selected fallback is the
    // only visible glyph fact available for this capture.
    const hasFallbackCandidate = pieces.some((piece) => {
      const family = piece.style.fontFamily;
      return !isGenericFontFamily(family) && authoredFontFamilyIsDeclared(family);
    });
    if (!hasFallbackCandidate) {
      return undefined;
    }
    // A pre/pre-wrap text node can span several browser-created visual lines
    // without carrying authored newlines. When no measured line boxes are
    // available, Canvas would draw the complete paragraph once and squeeze it
    // into the union width. Keep the editable text/substitution path instead
    // of shipping a demonstrably wrong one-line pixel fallback.
    if (measuredLines === undefined && bounds.height > style.lineHeightPx * 1.5) {
      return undefined;
    }
    const sourceStyles: CSSStyleDeclaration[] = [];
    for (const piece of pieces) {
      const sourceElement = piece.node.parentElement;
      if (sourceElement === null) return undefined;
      sourceStyles.push(getComputedStyle(sourceElement));
    }
    if (
      sourceStyles.some(
        (sourceStyle) =>
          sourceStyle.writingMode !== "horizontal-tb" ||
          sourceStyle.visibility === "hidden" ||
          Number.parseFloat(sourceStyle.opacity) === 0,
      )
    ) {
      return undefined;
    }
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (width > 8192 || height > 8192 || width * height > 4_000_000) {
      return undefined;
    }
    if (measuredLines === undefined && text.includes("\n")) {
      // No measured y positions means a preformatted multiline fallback
      // would require re-deriving browser layout. Keep editable text instead.
      return undefined;
    }
    interface TextFallbackOperation {
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      fontSizePx: number;
      sourceStyle: CSSStyleDeclaration;
    }
    let operations: TextFallbackOperation[];
    if (segments.length === 1) {
      const sourceStyle = sourceStyles[0];
      if (sourceStyle === undefined) return undefined;
      operations =
        measuredLines !== undefined && measuredLines.length > 0
          ? measuredLines.map((line) => ({
              text: transformCapturedText(line.text, style.textTransform),
              x: line.x - bounds.x,
              y: line.y - bounds.y,
              width: line.width,
              height: line.height,
              fontSizePx: style.fontSizePx,
              sourceStyle,
            }))
          : [
              {
                text: transformCapturedText(text, style.textTransform),
                x: 0,
                y: 0,
                width: bounds.width,
                height: bounds.height,
                fontSizePx: style.fontSizePx,
                sourceStyle,
              },
            ];
    } else {
      operations = [];
      const fragmentRange = document.createRange();
      try {
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
          const piece = pieces[pieceIndex];
          const sourceStyle = sourceStyles[pieceIndex];
          if (piece === undefined || sourceStyle === undefined) return undefined;
          fragmentRange.selectNodeContents(piece.node);
          const rects = Array.from(fragmentRange.getClientRects()).filter(
            (fragment) => fragment.width > 0.01 && fragment.height > 0.01,
          );
          const fragmentTexts = piece.text.split("\n").filter((fragment) => fragment.length > 0);
          // Browser Range fragments are the geometry authority. If a bidi or
          // generated-break case cannot be paired exactly with captured text,
          // retain editable text instead of inventing fragment positions.
          if (rects.length !== fragmentTexts.length) return undefined;
          for (let fragmentIndex = 0; fragmentIndex < rects.length; fragmentIndex += 1) {
            const fragment = rects[fragmentIndex];
            const fragmentText = fragmentTexts[fragmentIndex];
            if (fragment === undefined || fragmentText === undefined) return undefined;
            operations.push({
              text: transformCapturedText(fragmentText, piece.style.textTransform),
              x: fragment.left + scrollX - bounds.x,
              y: fragment.top + scrollY - bounds.y,
              width: fragment.width,
              height: fragment.height,
              fontSizePx: piece.style.fontSizePx,
              sourceStyle,
            });
          }
        }
      } finally {
        fragmentRange.detach();
      }
      if (operations.length === 0) return undefined;
    }
    const key = JSON.stringify([
      width,
      height,
      operations.map((operation) => [
        operation.text,
        operation.x,
        operation.y,
        operation.width,
        operation.height,
        canvasFontFromComputedStyle(operation.sourceStyle),
        operation.sourceStyle.color,
        operation.sourceStyle.direction,
        operation.sourceStyle.letterSpacing,
        operation.sourceStyle.wordSpacing,
      ]),
    ]);
    const existing = textFontFallbackAssetIds.get(key);
    if (existing !== undefined) return existing;
    if (
      textFontFallbackAssetIds.size >= maxTextFontFallbackAssets ||
      textFontFallbackPixels + width * height * dpr * dpr > maxTextFontFallbackPixels
    ) {
      warnTextFontFallbackBudget();
      return undefined;
    }
    try {
      const canvas = document.createElement("canvas");
      // Device-pixel backing store prevents 1× canvas AA from shredding
      // condensed display faces (The Verge Manuka) into vertical white slits.
      canvas.width = Math.max(1, Math.ceil(width * dpr));
      canvas.height = Math.max(1, Math.ceil(height * dpr));
      const context = canvas.getContext("2d");
      if (context === null) return undefined;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.textBaseline = "alphabetic";
      const advanced = context as CanvasRenderingContext2D & {
        fontKerning?: string;
        fontStretch?: string;
        fontVariantCaps?: string;
        letterSpacing?: string;
        wordSpacing?: string;
      };
      for (const operation of operations) {
        if (operation.text.length === 0) continue;
        const sourceStyle = operation.sourceStyle;
        context.font = canvasFontFromComputedStyle(sourceStyle);
        context.fillStyle = sourceStyle.color;
        context.direction = sourceStyle.direction === "rtl" ? "rtl" : "ltr";
        const applySpacing = (): void => {
          if ("letterSpacing" in advanced) advanced.letterSpacing = sourceStyle.letterSpacing;
          if ("wordSpacing" in advanced) advanced.wordSpacing = sourceStyle.wordSpacing;
        };
        const applyVariableAxes = (): void => {
          if ("fontKerning" in advanced) {
            advanced.fontKerning = sourceStyle.fontKerning as typeof advanced.fontKerning;
          }
          if ("fontStretch" in advanced) {
            advanced.fontStretch = canvasFontStretchFromCss(
              sourceStyle.fontStretch,
            ) as typeof advanced.fontStretch;
          }
          if ("fontVariantCaps" in advanced) {
            advanced.fontVariantCaps =
              sourceStyle.fontVariantCaps as typeof advanced.fontVariantCaps;
          }
        };
        const clearVariableAxes = (): void => {
          // Canvas defaults: avoid stretch/kerning that shred condensed faces
          // into slits when the engine's axis mapping disagrees with layout.
          if ("fontKerning" in advanced) advanced.fontKerning = "auto";
          if ("fontStretch" in advanced) advanced.fontStretch = "normal";
          if ("fontVariantCaps" in advanced) advanced.fontVariantCaps = "normal";
        };
        applyVariableAxes();
        applySpacing();
        const rtl = sourceStyle.direction === "rtl";
        context.textAlign = rtl ? "right" : "left";
        const fitWidth = Math.max(operation.width, 0.01);
        // Closed loop vs Range fragment width (layout authority). When Canvas
        // advances are severely wider after applying CSS axes, drop the axes
        // and remeasure — then only squeeze with maxWidth on mild mismatch.
        let metrics = context.measureText(operation.text);
        if (metrics.width > fitWidth * 1.35) {
          clearVariableAxes();
          context.font = canvasFontFromComputedStyle(sourceStyle);
          applySpacing();
          metrics = context.measureText(operation.text);
        }
        const ascent = metrics.actualBoundingBoxAscent || operation.fontSizePx * 0.8;
        const descent = metrics.actualBoundingBoxDescent || operation.fontSizePx * 0.2;
        const baseline =
          operation.y +
          Math.max(ascent, (operation.height - ascent - descent) / 2 + ascent);
        const x = rtl ? operation.x + operation.width : operation.x;
        if (metrics.width <= fitWidth * 1.35) {
          context.fillText(operation.text, x, baseline, fitWidth);
        } else {
          context.fillText(operation.text, x, baseline);
        }
      }
      const assetId = registerInlineAsset(
        "raster-image",
        canvas.toDataURL("image/png"),
        "image/png",
        width,
        height,
        true,
      );
      textFontFallbackAssetIds.set(key, assetId);
      textFontFallbackPixels += width * height * dpr * dpr;
      textFontFallbackCharacters += text.length;
      return assetId;
    } catch {
      return undefined;
    }
  }

  function buildTextNode(pieces: TextRunPiece[], containerStyle: CSSStyleDeclaration): CaptureNode | null {
    if (pieces.length === 0) {
      return null;
    }
    const firstPiece = pieces[0];
    const lastPiece = pieces[pieces.length - 1];
    if (!firstPiece || !lastPiece) {
      return null;
    }
    const range = document.createRange();
    range.setStartBefore(firstPiece.node);
    range.setEndAfter(lastPiece.node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    // Read the browser's own line fragments before deciding whether the more
    // expensive per-character pass is necessary. A one-line Range is already
    // a complete line-break fact: carrying it downstream prevents another
    // font engine from re-wrapping tightly fitted headings/buttons. Multiple
    // fragments on the same visual line are merged by vertical overlap (for
    // mixed inline styles); multiple visual bands use the exact character
    // pass below so Latin, CJK, Arabic/RTL and mixed scripts keep their breaks.
    interface BrowserLineBand {
      top: number;
      left: number;
      right: number;
      bottom: number;
    }
    const browserLineBands: BrowserLineBand[] = [];
    for (const fragment of Array.from(range.getClientRects())) {
      if (fragment.width <= 0.01 || fragment.height <= 0.01) continue;
      const overlappingBand = browserLineBands.find((band) => {
        const overlap =
          Math.min(band.bottom, fragment.bottom) - Math.max(band.top, fragment.top);
        const shorterHeight = Math.min(
          band.bottom - band.top,
          fragment.bottom - fragment.top,
        );
        // Tight line-height commonly makes neighboring glyph boxes touch or
        // overlap by a pixel. Same-line mixed-style fragments overlap through
        // most of the shorter box (including superscript/subscript), so require
        // majority overlap instead of treating any paint intersection as one
        // browser line.
        return shorterHeight > 0.01 && overlap / shorterHeight >= 0.5;
      });
      if (overlappingBand === undefined) {
        browserLineBands.push({
          top: fragment.top,
          left: fragment.left,
          right: fragment.right,
          bottom: fragment.bottom,
        });
      } else {
        overlappingBand.top = Math.min(overlappingBand.top, fragment.top);
        overlappingBand.left = Math.min(overlappingBand.left, fragment.left);
        overlappingBand.right = Math.max(overlappingBand.right, fragment.right);
        overlappingBand.bottom = Math.max(overlappingBand.bottom, fragment.bottom);
      }
    }
    browserLineBands.sort((a, b) => a.top - b.top || a.left - b.left);

    // For multi-line text, enumerate the browser's own line boxes by
    // clustering per-character rects (Range API). Downstream renders with
    // explicit newlines + measured line boxes, so line structure survives even
    // when Figma substitutes a font with different metrics.
    const lineHeightRef = firstPiece.style.lineHeightPx || firstPiece.style.fontSizePx * 1.2;
    const preservesWhitespace = containerStyle.whiteSpace.startsWith("pre");
    const totalLength = pieces.reduce((sum, piece) => sum + piece.text.length, 0);
    // Range-per-character measurement is exact but must stay bounded on
    // pathological text nodes. The former 5k cutoff was low enough to drop
    // line facts from ordinary long-form articles; raise the closed browser
    // measurement window while keeping a hard upper bound. Text beyond this
    // window remains fixed-width downstream, so it degrades to target-runtime
    // wrapping instead of becoming one unbounded line.
    const maxMeasuredTextCharacters = 20_000;
    let measuredLines: TextLineBox[] | undefined;
    let measuredSingleLineBand =
      browserLineBands.length === 1 ? browserLineBands[0] : undefined;
    // Ink rect may replace an inflated Range union. Absolute-positioned
    // sibling spans (rotating hero words) and trailing collapsed whitespace
    // can stretch getBoundingClientRect() to ~2× lineHeight even when the
    // visible glyphs occupy a single line — that tall box later overlaps the
    // positioned word in conversion/preview.
    let inkBoundsRect: DOMRect | undefined;
    // Measure whenever Range fragments prove that more than one visual band
    // exists. Do not infer the line count from union-height/line-height ratios.
    if (browserLineBands.length > 1 && totalLength <= maxMeasuredTextCharacters) {
      const measureRange = document.createRange();
      interface LineAccumulator {
        top: number;
        left: number;
        right: number;
        bottom: number;
        text: string;
      }
      const lines: LineAccumulator[] = [];
      let currentLine: LineAccumulator | null = null;
      // Line transition threshold: the new character's top is more than half a
      // line height below the current line's top.
      const lineBreakThreshold = Math.max(lineHeightRef * 0.5, firstPiece.style.fontSizePx * 0.5);

      for (const piece of pieces) {
        const raw = piece.node.nodeValue ?? "";
        let rebuilt = "";
        let measurable = true;
        let pendingWhitespace = false;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i] ?? "";
          if (isCssCollapsibleWhitespace(ch)) {
            // Defer collapsed whitespace until the next visible character
            // determines whether it represents a space or a line break.
            pendingWhitespace = true;
            continue;
          }
          let charRect: DOMRect | undefined;
          try {
            measureRange.setStart(piece.node, i);
            measureRange.setEnd(piece.node, i + 1);
            // Prefer a rect with ink; skip zero-size collapsed whitespace boxes.
            const clientRects = measureRange.getClientRects();
            charRect = undefined;
            for (let rectIndex = 0; rectIndex < clientRects.length; rectIndex += 1) {
              const candidate = clientRects.item(rectIndex);
              if (candidate && candidate.width > 0 && candidate.height > 0) {
                charRect = candidate;
                break;
              }
            }
          } catch {
            measurable = false;
            break;
          }
          if (charRect === undefined) {
            // Soft hyphen / zero-width / fully collapsed glyph: keep pending
            // whitespace state but do not invent a line box.
            continue;
          }
          const top: number = charRect.top;
          const startsNewLine = currentLine !== null && top - currentLine.top > lineBreakThreshold;
          if (currentLine === null || startsNewLine) {
            currentLine = {
              top,
              left: charRect.left,
              right: charRect.right,
              bottom: charRect.bottom,
              text: ch,
            };
            lines.push(currentLine);
            // At line start, fold deferred whitespace into the line break so
            // scripts without spaces do not gain an extra space.
            rebuilt += rebuilt.length > 0 || lines.length > 1 ? `\n${ch}` : ch;
            pendingWhitespace = false;
          } else {
            if (pendingWhitespace) {
              rebuilt += " ";
              currentLine.text += " ";
              pendingWhitespace = false;
            }
            rebuilt += ch;
            currentLine.text += ch;
            currentLine.left = Math.min(currentLine.left, charRect.left);
            currentLine.right = Math.max(currentLine.right, charRect.right);
            currentLine.bottom = Math.max(currentLine.bottom, charRect.bottom);
          }
        }
        if (!measurable) {
          continue;
        }
        // When a fragment ends in whitespace, retain one space to preserve word
        // separation across the next fragment.
        if (pendingWhitespace && rebuilt.length > 0) {
          rebuilt += " ";
          if (currentLine) currentLine.text += " ";
        }
        if (rebuilt.length > 0 || !hasNonCollapsibleContent(raw)) {
          piece.text = rebuilt;
        }
      }
      if (lines.length > 1) {
        measuredLines = lines.map((line) => ({
          text: trimCssCollapsibleWhitespaceEnd(line.text),
          x: line.left + scrollX,
          y: line.top + scrollY,
          width: Math.max(0, line.right - line.left),
          height: Math.max(0, line.bottom - line.top),
        }));
        inkBoundsRect = new DOMRect(
          Math.min(...lines.map((line) => line.left)),
          Math.min(...lines.map((line) => line.top)),
          Math.max(...lines.map((line) => line.right)) - Math.min(...lines.map((line) => line.left)),
          Math.max(...lines.map((line) => line.bottom)) - Math.min(...lines.map((line) => line.top)),
        );
      } else if (lines.length === 1) {
        const line = lines[0]!;
        measuredSingleLineBand = line;
        inkBoundsRect = new DOMRect(
          line.left,
          line.top,
          Math.max(0, line.right - line.left),
          Math.max(0, line.bottom - line.top),
        );
      }
    }

    const segments: TextSegment[] = [];
    for (const piece of pieces) {
      const previous = segments[segments.length - 1];
      if (previous && JSON.stringify(previous.style) === JSON.stringify(piece.style)) {
        previous.text += piece.text;
      } else {
        segments.push({ text: piece.text, style: piece.style });
      }
    }
    let combined = segments.map((segment) => segment.text).join("");
    if (!hasNonCollapsibleContent(combined)) {
      return null;
    }
    // Only trim boundary whitespace that the browser actually collapsed away.
    // A Range over the whitespace itself reports positive geometry when it is
    // painted between independently captured inline children. Keeping those
    // characters preserves the browser's word gap without guessing from DOM
    // shape or text content.
    const leadingTrim = hasRenderedBoundaryWhitespace(firstPiece, "start")
      ? 0
      : combined.length - trimCssCollapsibleWhitespaceStart(combined).length;
    const trailingTrim = hasRenderedBoundaryWhitespace(lastPiece, "end")
      ? 0
      : combined.length - trimCssCollapsibleWhitespaceEnd(combined).length;
    if (leadingTrim > 0 && segments[0]) {
      segments[0].text = segments[0].text.slice(leadingTrim);
    }
    if (trailingTrim > 0) {
      const lastSegment = segments[segments.length - 1];
      if (lastSegment) {
        lastSegment.text = lastSegment.text.slice(
          0,
          Math.max(0, lastSegment.text.length - trailingTrim),
        );
      }
    }
    const filteredSegments = segments.filter((segment) => segment.text.length > 0);
    if (filteredSegments.length === 0) {
      return null;
    }
    combined = filteredSegments.map((segment) => segment.text).join("");

    if (measuredLines === undefined && measuredSingleLineBand !== undefined) {
      measuredLines = [
        {
          text: combined,
          x: measuredSingleLineBand.left + scrollX,
          y: measuredSingleLineBand.top + scrollY,
          width: Math.max(0, measuredSingleLineBand.right - measuredSingleLineBand.left),
          height: Math.max(0, measuredSingleLineBand.bottom - measuredSingleLineBand.top),
        },
      ];
      inkBoundsRect = new DOMRect(
        measuredSingleLineBand.left,
        measuredSingleLineBand.top,
        Math.max(0, measuredSingleLineBand.right - measuredSingleLineBand.left),
        Math.max(0, measuredSingleLineBand.bottom - measuredSingleLineBand.top),
      );
    }

    let dominant = filteredSegments[0];
    for (const segment of filteredSegments) {
      if (dominant && segment.text.length > dominant.text.length) {
        dominant = segment;
      }
    }
    if (!dominant) {
      return null;
    }
    // Container-level text-align wins over segment-level (inline align is meaningless).
    // start/end are logical values and must be resolved using the measured
    // direction fact (start means right in RTL).
    const containerAlign = containerStyle.textAlign;
    const containerRtl = containerStyle.direction === "rtl";
    const resolvedAlign =
      containerAlign === "left" ||
      containerAlign === "center" ||
      containerAlign === "right" ||
      containerAlign === "justify"
        ? containerAlign
        : containerAlign === "end"
          ? containerRtl
            ? "left"
            : "right"
          : containerRtl
            ? "right"
            : "left";
    const style: TextStyle = { ...dominant.style, textAlign: resolvedAlign };

    const textShadows = extractTextShadows(containerStyle);
    // Measured facts: direction, writing mode, preserved line breaks, and
    // background-clip:text fills.
    const direction = containerStyle.direction === "rtl" ? ("rtl" as const) : undefined;
    const wm = containerStyle.writingMode;
    const writingMode =
      wm === "vertical-rl" || wm === "vertical-lr" || wm === "sideways-rl" || wm === "sideways-lr"
        ? wm
        : undefined;
    // text-orientation: upright cannot be represented by rotating horizontal
    // text 90 degrees. Record the fact so downstream consumers can warn about
    // the fallback instead of applying an incorrect rotation.
    const textOrientation =
      writingMode !== undefined && containerStyle.textOrientation === "upright"
        ? ("upright" as const)
        : undefined;
    const preservesNewlines = preservesWhitespace ? true : undefined;
    // background-clip:text is read directly from computed style without
    // heuristics. Text uses the container fills rather than style.color, which
    // is often transparent and otherwise produces black output.
    let fillClip: { fills: Paint[] } | undefined;
    const bgClip =
      containerStyle.backgroundClip ||
      containerStyle.getPropertyValue("-webkit-background-clip") ||
      "";
    if (bgClip.includes("text")) {
      const clipFills = extractFills(containerStyle, rect.width, rect.height);
      if (clipFills.length > 0) {
        fillClip = { fills: clipFills };
      }
    }
    const bounds = toPageRect(inkBoundsRect ?? rect);
    const fontFallbackAssetId =
      fillClip === undefined
        ? rasterizeDomTextFontFallback(
            pieces,
            filteredSegments,
            combined,
            style,
            bounds,
            measuredLines,
          )
        : undefined;
    // Required only for closed browser glyph facts (fallback face / PUA).
    // Condensed display titles keep an optional fontFallbackAssetId; preview
    // and the Figma plugin consume it when the authored family cannot resolve.
    const fontFallbackRequired =
      fontFallbackAssetId !== undefined &&
      (browserRenderedTextUsesFallbackFont(pieces) ||
        browserRenderedTextUsesAuthoredPrivateUseFont(pieces) ||
        browserRenderedTextUsesFailedAuthoredFont(pieces));
    textNodeCount += 1;
    nodeCount += 1;
    return {
      id: nextNodeId(),
      type: "text",
      tag: "#text",
      name: combined.length > 24 ? `${combined.slice(0, 24)}…` : combined,
      bounds,
      opacity: 1,
      clipsContent: false,
      text: combined,
      segments: filteredSegments,
      style,
      ...(textShadows !== undefined ? { shadows: textShadows } : {}),
      ...(fontFallbackAssetId !== undefined ? { fontFallbackAssetId } : {}),
      ...(fontFallbackRequired ? { fontFallbackRequired: true as const } : {}),
      ...(measuredLines !== undefined ? { measuredLines } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(writingMode !== undefined ? { writingMode } : {}),
      ...(textOrientation !== undefined ? { textOrientation } : {}),
      ...(preservesNewlines !== undefined ? { preservesNewlines } : {}),
      ...(fillClip !== undefined ? { fillClip } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Element walkers
  // -------------------------------------------------------------------------

  function walkImage(element: HTMLImageElement, style: CSSStyleDeclaration, rect: DOMRect): CaptureNode | null {
    // JS lazy-loaders keep the real URL in data-* until the swap fires;
    // if the swap never ran, recover the source from those attributes.
    const src =
      element.currentSrc ||
      element.src ||
      element.getAttribute("data-src") ||
      element.getAttribute("data-lazy-src") ||
      element.getAttribute("data-original") ||
      "";
    imageNodeCount += 1;
    nodeCount += 1;
    const nodeId = nextNodeId();
    // Keep the browser element and the exact source observed by extraction in
    // page memory. The host capture engine compares this fact after asset
    // resolution because responsive images and rotating creatives can swap
    // currentSrc without changing layout. A DOM attribute would mutate the
    // page and can itself disturb mutation-driven applications.
    const imageElements =
      ((window as unknown as Record<string, unknown>).__h2fImageElements as
        | Map<string, HTMLImageElement>
        | undefined) ?? new Map<string, HTMLImageElement>();
    const imageSources =
      ((window as unknown as Record<string, unknown>).__h2fImageSources as
        | Map<string, { currentSrc: string; src: string }>
        | undefined) ?? new Map<string, { currentSrc: string; src: string }>();
    imageElements.set(nodeId, element);
    imageSources.set(nodeId, { currentSrc: element.currentSrc, src: element.src });
    (window as unknown as Record<string, unknown>).__h2fImageElements = imageElements;
    (window as unknown as Record<string, unknown>).__h2fImageSources = imageSources;
    const cornerRadii = extractCornerRadii(style, rect.width, rect.height);
    const borders = extractBorders(style);
    const shadows = extractShadows(style);
    const clipBounds = extractRectangularClipBounds(style, rect);
    const base = {
      id: nodeId,
      type: "image" as const,
      tag: "img",
      name: layerName(element),
      bounds: toPageRect(rect),
      opacity: Number.parseFloat(style.opacity) || 1,
      clipsContent: false,
      scaleMode: scaleModeFromCss(style.objectFit),
      ...(cornerRadii !== undefined ? { cornerRadii } : {}),
      ...(borders !== undefined ? { borders } : {}),
      ...(shadows !== undefined ? { shadows } : {}),
      ...(clipBounds !== undefined ? { clipBounds } : {}),
      ...(element.naturalWidth > 0 ? { naturalWidth: element.naturalWidth } : {}),
      ...(element.naturalHeight > 0 ? { naturalHeight: element.naturalHeight } : {}),
      ...(element.alt ? { altText: element.alt } : {}),
      ...extractStackingFacts(style, element.parentElement, element),
    };
    // Asset resolution happens after extraction (and may fail only in the
    // extension/background fetch context). Keep a temporary DOM binding for
    // every real <img>; the post-resolution phase screenshots only the nodes
    // whose asset is still unresolved, so successful images pay no raster cost.
    markForScreenshotFallback(element, nodeId);
    if (!src) {
      addWarning("asset_fetch_failed", "img without src", nodeId);
      return { ...base, assetMissing: true };
    }
    if (src.startsWith("data:")) {
      const headerEnd = src.indexOf(",");
      const header = headerEnd >= 0 ? src.slice(5, headerEnd) : "";
      const mediaType = (header.split(";")[0] || "image/png").trim() || "image/png";
      // SVG data URIs (base64 or percent-encoded) carry vector markup —
      // route them through the SVG pipeline so Figma keeps them crisp
      // instead of failing to decode them as raster bytes downstream.
      if (mediaType === "image/svg+xml" && headerEnd >= 0) {
        const payload = src.slice(headerEnd + 1);
        let markup: string | null = null;
        try {
          markup = header.includes("base64") ? atob(payload) : decodeURIComponent(payload);
        } catch {
          markup = null;
        }
        if (markup !== null && markup.includes("<svg")) {
          const assetId = registerInlineAsset(
            "svg-inline",
            markup,
            "image/svg+xml",
            rect.width,
            rect.height,
          );
          return { ...base, assetId };
        }
      }
      const assetId = registerInlineAsset(
        "raster-image",
        src,
        mediaType,
        element.naturalWidth || undefined,
        element.naturalHeight || undefined,
      );
      return { ...base, assetId };
    }
    const resolved = resolveUrl(src);
    if (!resolved) {
      addWarning("asset_fetch_failed", "unresolvable img src", nodeId);
      return { ...base, assetMissing: true };
    }
    // The initial kind is only a hint; the engine replaces it with the response
    // Content-Type fact. `includes(".svg")` would misclassify paths such as
    // "/design.svg-icons/logo.png".
    const kind = /\.svg([?#]|$)/i.test(resolved) ? "svg-image" : "raster-image";
    const assetId = registerRemoteAsset(resolved, kind);
    return { ...base, assetId };
  }

  function walkSvg(element: SVGSVGElement, style: CSSStyleDeclaration, rect: DOMRect): CaptureNode | null {
    // External <use href="/sprite.svg#id"> references survive serialization as
    // dangling URLs; isSafeSvgMarkup rejects them and conversion drops the
    // icon. The browser already painted the sprite — screenshot that fact.
    const uses = element.querySelectorAll("use");
    for (let index = 0; index < uses.length; index += 1) {
      const use = uses[index];
      if (use === undefined) continue;
      const href =
        use.getAttribute("href") ??
        use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (href !== null && href.length > 0 && !href.startsWith("#")) {
        return walkScreenshotFallbackElement(element, style, rect, "external-svg-use", {
          code: "unsupported_paint",
          detail: "SVG external <use> sprite requires browser screenshot fallback",
        });
      }
    }
    // Host CSS transforms (e.g. rotate(-90deg) brand marks): Figma SVG import
    // cannot honor CSS transform-origin. Bake the measured 2D matrix into the
    // markup so the AABB bounds match painted pixels without a screenshot
    // (composited screenshots on photo backdrops can tear thin monochrome strokes).
    const hostTransform = style.transform && style.transform !== "none" ? style.transform : null;
    const hostMatrix = hostTransform !== null ? parseMatrix2d(hostTransform) : null;
    if (hostTransform !== null && hostMatrix === null) {
      return walkScreenshotFallbackElement(element, style, rect, "transformed-subtree", {
        code: "unsupported_transform",
        detail: "SVG host CSS transform cannot be baked; screenshot fallback",
      });
    }
    nodeCount += 1;
    // SVGs that draw text (<text>/<tspan>) or embed HTML (<foreignObject>)
    // cannot round-trip as vector markup: Figma's createNodeFromSvg drops
    // text elements entirely (e.g. a gradient "Sign in" button renders as an
    // empty rect). Defer to the engine's element screenshot so the composited
    // pixels the user sees are captured instead.
    const hasTextOrHtml = element.querySelector("text, foreignObject") !== null;
    const hasResourcePaint = element.querySelector("style, image") !== null;
    if (hasTextOrHtml || hasResourcePaint) {
      // Sparse monochrome SVG text (section titles) and CSS-styled SVG paint
      // need browser pixels. Label the fallback so the engine can exempt it
      // from the large chromatic-flat gate (white glyphs on transparency look
      // "empty" under that heuristic and used to become placeholders).
      return walkScreenshotFallbackElement(
        element,
        style,
        rect,
        hasResourcePaint ? "svg-resource-paint" : "svg-text",
        {
          code: "canvas_rasterized",
          detail: hasResourcePaint
            ? "SVG resource paint requires browser screenshot fallback"
            : "svg with text/foreignObject: screenshot fallback",
        },
      );
    }
    const svgDescendants = Array.from(element.querySelectorAll("*"));
    const unsupportedTransformedDescendant = svgDescendants.some((descendant) => {
      const computed = getComputedStyle(descendant);
      if (!computed.transform || computed.transform === "none") {
        return false;
      }
      const descendantRect = descendant.getBoundingClientRect();
      return (
        parseMatrix2d(computed.transform) === null ||
        parseTransformOrigin(computed, descendantRect.width, descendantRect.height) === null
      );
    });
    if (unsupportedTransformedDescendant) {
      const nodeId = nextNodeId();
      imageNodeCount += 1;
      markForScreenshotFallback(element, nodeId);
      addWarning(
        "unsupported_transform",
        "SVG descendant transform cannot be baked; screenshot fallback",
        nodeId,
      );
      return {
        id: nodeId,
        type: "image",
        tag: "svg",
        name: layerName(element),
        bounds: toPageRect(rect),
        opacity: Number.parseFloat(style.opacity) || 1,
        clipsContent: false,
        assetMissing: true,
        fallbackLabel: "transformed-svg",
        scaleMode: "fill",
      };
    }
    let markup: string | null = null;
    try {
      const clone = element.cloneNode(true) as SVGSVGElement;

      // Inline computed presentation styles BEFORE any clone mutation so the
      // original/clone descendant lists stay index-aligned. Stylesheet rules,
      // CSS variables, and currentColor do not survive serialization, so the
      // resolved values must be baked into each element.
      const svgPresentationProps = [
        "fill",
        "fill-opacity",
        "fill-rule",
        "stroke",
        "stroke-opacity",
        "stroke-width",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "stop-color",
        "stop-opacity",
        "color",
        "visibility",
      ];
      const inheritsAuthoredCurrentColor = (
        source: Element,
        property: string,
        scopeRoot: Element,
      ): boolean => {
        let current: Element | null = source;
        while (current !== null) {
          const attributeValue = current.getAttribute(property);
          const inlineValue =
            current instanceof SVGElement ? current.style.getPropertyValue(property) : "";
          const authoredValue = inlineValue !== "" ? inlineValue : attributeValue;
          if (authoredValue !== null && authoredValue !== "") {
            return /currentcolor/iu.test(authoredValue);
          }
          if (current === scopeRoot) return false;
          current = current.parentElement;
        }
        return false;
      };
      const inheritsSameComputedPresentation = (
        source: Element,
        property: string,
        computed: CSSStyleDeclaration,
      ): boolean => {
        const attributeValue = source.getAttribute(property);
        const inlineValue =
          source instanceof SVGElement ? source.style.getPropertyValue(property) : "";
        if (inlineValue !== "" || (attributeValue !== null && attributeValue !== "")) {
          return false;
        }
        const parent = source.parentElement;
        if (!(parent instanceof SVGElement)) return false;
        return (
          computed.getPropertyValue(property) ===
          getComputedStyle(parent).getPropertyValue(property)
        );
      };
      const inlineComputedStyle = (
        source: Element,
        target: Element,
        preserveAuthoredCurrentColor = false,
        currentColorScopeRoot?: Element,
      ): void => {
        const computed = getComputedStyle(source);
        let styleText = "";
        for (const prop of svgPresentationProps) {
          if (
            preserveAuthoredCurrentColor &&
            (inheritsAuthoredCurrentColor(source, prop, currentColorScopeRoot ?? source) ||
              inheritsSameComputedPresentation(source, prop, computed))
          ) {
            continue;
          }
          const value = computed.getPropertyValue(prop);
          if (value !== "" && value !== "normal") {
            styleText += `${prop}:${value};`;
          }
        }
        if (styleText !== "") {
          target.setAttribute("style", styleText);
        }
        if (source !== element && computed.transform && computed.transform !== "none") {
          const matrix = parseMatrix2d(computed.transform);
          const sourceRect = source.getBoundingClientRect();
          const origin = parseTransformOrigin(computed, sourceRect.width, sourceRect.height);
          if (matrix !== null && origin !== null) {
            const e = matrix.e + origin.x - matrix.a * origin.x - matrix.c * origin.y;
            const f = matrix.f + origin.y - matrix.b * origin.x - matrix.d * origin.y;
            target.setAttribute(
              "transform",
              `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${e} ${f})`,
            );
          }
        }
      };
      inlineComputedStyle(element, clone);
      const originalDescendants = element.querySelectorAll("*");
      const cloneDescendants = clone.querySelectorAll("*");
      const pairCount = Math.min(originalDescendants.length, cloneDescendants.length);
      for (let index = 0; index < pairCount; index += 1) {
        const source = originalDescendants[index];
        const target = cloneDescendants[index];
        if (source !== undefined && target !== undefined && target.tagName !== "script") {
          inlineComputedStyle(source, target);
        }
      }

      // A visible icon often consists only of <use href="#sprite-id"> while
      // the referenced <symbol> lives in a hidden sibling SVG. Serializing the
      // visible subtree alone leaves a dangling reference, so carry the exact
      // same-document SVG targets into local <defs>. This is DOM reference
      // resolution, not an icon-name or glyph heuristic.
      const referencedIds = new Set<string>();
      const pendingUses = Array.from(clone.querySelectorAll("use"));
      const referencedDefs = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "defs",
      );
      for (let index = 0; index < pendingUses.length; index += 1) {
        const use = pendingUses[index];
        if (use === undefined) continue;
        const href =
          use.getAttribute("href") ??
          use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
        if (href === null || !href.startsWith("#") || href.length <= 1) continue;
        const referencedId = href.slice(1);
        if (referencedIds.has(referencedId)) continue;
        const source = element.ownerDocument.getElementById(referencedId) as Element | null;
        if (
          !(source instanceof SVGElement) ||
          source === element ||
          element.contains(source)
        ) {
          continue;
        }
        referencedIds.add(referencedId);
        const target = source.cloneNode(true) as SVGElement;
        const sourceTree = [source, ...Array.from(source.querySelectorAll("*"))];
        const targetTree = [target, ...Array.from(target.querySelectorAll("*"))];
        const referencedPairCount = Math.min(sourceTree.length, targetTree.length);
        for (let pairIndex = 0; pairIndex < referencedPairCount; pairIndex += 1) {
          const sourceNode = sourceTree[pairIndex];
          const targetNode = targetTree[pairIndex];
          if (sourceNode !== undefined && targetNode !== undefined) {
            inlineComputedStyle(sourceNode, targetNode, true, source);
          }
        }
        pendingUses.push(...Array.from(target.querySelectorAll("use")));
        referencedDefs.append(target);
      }
      if (referencedDefs.childElementCount > 0) {
        clone.insertBefore(referencedDefs, clone.firstChild);
      }

      for (const script of Array.from(clone.querySelectorAll("script"))) {
        script.remove();
      }
      for (const handler of Array.from(clone.querySelectorAll("*"))) {
        for (const attribute of Array.from(handler.attributes)) {
          if (attribute.name.startsWith("on")) {
            handler.removeAttribute(attribute.name);
          }
        }
      }
      if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      // Figma's createNodeFromSvg trims the imported frame to the drawn
      // content, discarding viewBox padding; the plugin then stretches the
      // trimmed art back to the DOM box (nav chevrons render oversized and
      // vertically offset). An invisible rect spanning the full viewBox pins
      // the import bounds to the CSS box so proportions and position hold.
      {
        const boundsRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        const viewBox = element.viewBox.baseVal;
        if (viewBox !== null && viewBox.width > 0 && viewBox.height > 0) {
          boundsRect.setAttribute("x", String(viewBox.x));
          boundsRect.setAttribute("y", String(viewBox.y));
          boundsRect.setAttribute("width", String(viewBox.width));
          boundsRect.setAttribute("height", String(viewBox.height));
        } else {
          boundsRect.setAttribute("x", "0");
          boundsRect.setAttribute("y", "0");
          boundsRect.setAttribute("width", "100%");
          boundsRect.setAttribute("height", "100%");
        }
        boundsRect.setAttribute("fill", "#ffffff");
        boundsRect.setAttribute("fill-opacity", "0");
        boundsRect.setAttribute("stroke", "none");
        clone.insertBefore(boundsRect, clone.firstChild);
      }
      let hostTransformBakeFailed = false;
      if (hostMatrix !== null) {
        // Layout box is the untransformed CSS size; `rect` is the painted AABB.
        const layoutW =
          element.clientWidth > 0 ? element.clientWidth : Math.max(1, rect.width);
        const layoutH =
          element.clientHeight > 0 ? element.clientHeight : Math.max(1, rect.height);
        const origin = parseTransformOrigin(style, layoutW, layoutH);
        if (origin === null) {
          hostTransformBakeFailed = true;
        } else {
          const mapPoint = (x: number, y: number): { x: number; y: number } => {
            const lx = x - origin.x;
            const ly = y - origin.y;
            return {
              x: hostMatrix.a * lx + hostMatrix.c * ly + hostMatrix.e + origin.x,
              y: hostMatrix.b * lx + hostMatrix.d * ly + hostMatrix.f + origin.y,
            };
          };
          const corners = [
            mapPoint(0, 0),
            mapPoint(layoutW, 0),
            mapPoint(layoutW, layoutH),
            mapPoint(0, layoutH),
          ];
          const minX = Math.min(corners[0]!.x, corners[1]!.x, corners[2]!.x, corners[3]!.x);
          const minY = Math.min(corners[0]!.y, corners[1]!.y, corners[2]!.y, corners[3]!.y);
          const maxX = Math.max(corners[0]!.x, corners[1]!.x, corners[2]!.x, corners[3]!.x);
          const maxY = Math.max(corners[0]!.y, corners[1]!.y, corners[2]!.y, corners[3]!.y);
          const aabbW = Math.max(1, maxX - minX);
          const aabbH = Math.max(1, maxY - minY);
          const originalViewBox = clone.getAttribute("viewBox");
          const inner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          inner.setAttribute("x", "0");
          inner.setAttribute("y", "0");
          inner.setAttribute("width", String(layoutW));
          inner.setAttribute("height", String(layoutH));
          if (originalViewBox !== null && originalViewBox !== "") {
            inner.setAttribute("viewBox", originalViewBox);
          } else {
            inner.setAttribute("viewBox", `0 0 ${layoutW} ${layoutH}`);
          }
          while (clone.firstChild !== null) {
            inner.append(clone.firstChild);
          }
          const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
          // CSS transform-origin semantics: T(origin) * M * T(-origin), then
          // shift so the transformed layout AABB starts at (0,0).
          group.setAttribute(
            "transform",
            `translate(${-minX} ${-minY}) translate(${origin.x} ${origin.y}) ` +
              `matrix(${hostMatrix.a} ${hostMatrix.b} ${hostMatrix.c} ${hostMatrix.d} ` +
              `${hostMatrix.e} ${hostMatrix.f}) translate(${-origin.x} ${-origin.y})`,
          );
          group.append(inner);
          clone.append(group);
          clone.setAttribute("width", String(aabbW));
          clone.setAttribute("height", String(aabbH));
          clone.setAttribute("viewBox", `0 0 ${aabbW} ${aabbH}`);
          // Pin the baked AABB so Figma import keeps the transformed frame.
          const aabbPin = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          aabbPin.setAttribute("x", "0");
          aabbPin.setAttribute("y", "0");
          aabbPin.setAttribute("width", String(aabbW));
          aabbPin.setAttribute("height", String(aabbH));
          aabbPin.setAttribute("fill", "#ffffff");
          aabbPin.setAttribute("fill-opacity", "0");
          aabbPin.setAttribute("stroke", "none");
          clone.insertBefore(aabbPin, clone.firstChild);
        }
      } else {
        if (!clone.getAttribute("width")) {
          clone.setAttribute("width", String(rect.width));
        }
        if (!clone.getAttribute("height")) {
          clone.setAttribute("height", String(rect.height));
        }
      }
      if (hostTransformBakeFailed) {
        markup = null;
      } else {
        // Resolve currentColor against the computed color.
        const currentColor = style.color;
        markup = new XMLSerializer()
          .serializeToString(clone)
          .replaceAll("currentColor", currentColor);
      }
    } catch {
      markup = null;
    }
    if (!markup || markup.length > 300_000) {
      if (hostMatrix !== null) {
        return walkScreenshotFallbackElement(element, style, rect, "transformed-subtree", {
          code: "unsupported_transform",
          detail: "SVG host CSS transform bake failed; screenshot fallback",
        });
      }
      const nodeId = nextNodeId();
      addWarning("asset_too_large", "inline svg too large or unserializable", nodeId);
      return {
        id: nodeId,
        type: "svg",
        tag: "svg",
        name: layerName(element),
        bounds: toPageRect(rect),
        opacity: Number.parseFloat(style.opacity) || 1,
        clipsContent: false,
        assetMissing: true,
      };
    }
    const assetId = registerInlineAsset("svg-inline", markup, "image/svg+xml", rect.width, rect.height);
    const nodeId = nextNodeId();
    const svgElements =
      ((window as unknown as Record<string, unknown>).__h2fSvgElements as
        | Map<string, SVGSVGElement>
        | undefined) ?? new Map<string, SVGSVGElement>();
    svgElements.set(nodeId, element);
    (window as unknown as Record<string, unknown>).__h2fSvgElements = svgElements;
    return {
      id: nodeId,
      type: "svg",
      tag: "svg",
      name: layerName(element),
      bounds: toPageRect(rect),
      opacity: Number.parseFloat(style.opacity) || 1,
      clipsContent: false,
      assetId,
    };
  }

  /**
   * True when a rasterized data URL contains at least one non-transparent
   * pixel. WebGL canvases without preserveDrawingBuffer and paused video
   * elements often rasterize to fully transparent images; those need the
   * out-of-page screenshot fallback instead.
   */
  function rasterHasInk(source: HTMLCanvasElement | HTMLVideoElement, width: number, height: number): boolean {
    try {
      const probe = document.createElement("canvas");
      const sampleW = Math.max(1, Math.min(32, width));
      const sampleH = Math.max(1, Math.min(32, height));
      probe.width = sampleW;
      probe.height = sampleH;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        return false;
      }
      ctx.drawImage(source, 0, 0, sampleW, sampleH);
      const pixels = ctx.getImageData(0, 0, sampleW, sampleH).data;
      for (let i = 3; i < pixels.length; i += 4) {
        if ((pixels[i] ?? 0) > 8) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Rasterize the current visual frame of a canvas or video element into a
   * PNG data URL. Returns null for tainted/blank sources.
   */
  function grabElementFrame(
    source: HTMLCanvasElement | HTMLVideoElement,
    width: number,
    height: number,
  ): string | null {
    if (width <= 0 || height <= 0 || !rasterHasInk(source, width, height)) {
      return null;
    }
    try {
      const frame = document.createElement("canvas");
      frame.width = width;
      frame.height = height;
      const ctx = frame.getContext("2d");
      if (!ctx) {
        return null;
      }
      ctx.drawImage(source, 0, 0, width, height);
      return frame.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  /**
   * Mark an element for the engine-side screenshot fallback. The capture
   * engine screenshots every tagged element after extraction and patches the
   * asset into the document.
   */
  function setCaptureMarker(element: Element, attribute: string, value: string): void {
    const globals = window as unknown as Record<string, unknown>;
    const states =
      (globals.__h2fCaptureMarkerStates as
        | WeakMap<Element, Map<string, { hadAttribute: boolean; value: string | null }>>
        | undefined) ??
      new WeakMap<Element, Map<string, { hadAttribute: boolean; value: string | null }>>();
    globals.__h2fCaptureMarkerStates = states;
    const elements =
      (globals.__h2fCaptureMarkerElements as Set<Element> | undefined) ??
      new Set<Element>();
    globals.__h2fCaptureMarkerElements = elements;
    elements.add(element);
    const elementStates = states.get(element) ?? new Map();
    if (!elementStates.has(attribute)) {
      elementStates.set(attribute, {
        hadAttribute: element.hasAttribute(attribute),
        value: element.getAttribute(attribute),
      });
      states.set(element, elementStates);
    }
    element.setAttribute(attribute, value);
  }

  function markForScreenshotFallback(element: Element, nodeId: string): void {
    try {
      setCaptureMarker(element, "data-h2f-shot", nodeId);
    } catch {
      // Ignore readonly elements; the node keeps assetMissing.
    }
  }

  function maskImageOf(style: CSSStyleDeclaration): string {
    return (
      style.getPropertyValue("mask-image") ||
      style.getPropertyValue("-webkit-mask-image") ||
      "none"
    ).trim();
  }

  function requiresMaskedSubtreeFallback(style: CSSStyleDeclaration): boolean {
    const maskImage = maskImageOf(style);
    if (maskImage === "" || maskImage === "none") {
      return false;
    }
    const layers = splitTopLevel(maskImage, ",");
    const singleUrl = layers.length === 1 ? parseCssUrl(layers[0]!) : null;
    const backgroundIsSolidOnly =
      (!style.backgroundImage || style.backgroundImage === "none") &&
      parseColor(style.backgroundColor) !== null;
    return singleUrl === null || !backgroundIsSolidOnly;
  }

  /**
   * Non-inset clip-path (polygon/circle/path/…) and inset shapes we cannot
   * project into an axis-aligned clipBounds must stay as browser-composited
   * screenshots. Only extractInsetClipBounds-compatible inset() is structural.
   */
  function requiresUnsupportedClipPathFallback(
    style: CSSStyleDeclaration,
    rect: DOMRect,
  ): boolean {
    const raw = style.clipPath?.trim() ?? "";
    if (raw === "" || raw === "none") {
      return false;
    }
    return extractInsetClipBounds(style, rect) === undefined;
  }

  /**
   * Honeycomb / isometric clip galleries (d3js.org examples) place dozens of
   * polygon-clipped cards under a transformed origin. Per-card AABB screenshots
   * cannot reassemble the browser composite — promote the common parent to one
   * clipped-subtree shot using the visible paint union.
   */
  function collectUnsupportedClipPathHosts(element: Element): Element[] {
    const hosts: Element[] = [];
    const candidates = element.querySelectorAll<Element>("*");
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates.item(index);
      if (candidate === null) continue;
      const candidateStyle = getComputedStyle(candidate);
      const candidateRect = candidate.getBoundingClientRect();
      if (candidateRect.width <= 1 || candidateRect.height <= 1) continue;
      if (!requiresUnsupportedClipPathFallback(candidateStyle, candidateRect)) {
        continue;
      }
      hosts.push(candidate);
    }
    return hosts;
  }

  function nearestClipClusterOwner(
    boundary: Element,
    hosts: readonly Element[],
  ): Element | null {
    let candidate = hosts[0]?.parentElement ?? null;
    while (candidate !== null) {
      if (hosts.every((host) => candidate?.contains(host) === true)) {
        return boundary.contains(candidate) ? candidate : null;
      }
      if (candidate === boundary) break;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function clippedSubtreeClusterPaintRect(
    element: Element,
    hosts: Element[],
    fallback: DOMRect,
  ): DOMRect {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const host of hosts) {
      const rect = host.getBoundingClientRect();
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      right <= left ||
      bottom <= top
    ) {
      return fallback;
    }
    // Match what the user sees: ancestor overflow clips the honeycomb edges.
    return clipPaintRectToAncestors(
      element,
      new DOMRect(left, top, right - left, bottom - top),
    );
  }

  function requiresClippedSubtreeClusterFallback(
    element: Element,
    style: CSSStyleDeclaration,
  ): { hosts: Element[] } | null {
    // Avoid promoting every page section: require a transformed origin or a
    // dense clip-path card cluster that escapes the host border box.
    const hosts = collectUnsupportedClipPathHosts(element);
    if (hosts.length < 8) {
      return null;
    }
    if (nearestClipClusterOwner(element, hosts) !== element) {
      return null;
    }
    const hostRect = element.getBoundingClientRect();
    let escapeCount = 0;
    for (const host of hosts) {
      const rect = host.getBoundingClientRect();
      if (
        rect.left < hostRect.left - 1 ||
        rect.top < hostRect.top - 1 ||
        rect.right > hostRect.right + 1 ||
        rect.bottom > hostRect.bottom + 1
      ) {
        escapeCount += 1;
      }
    }
    const hasTransform = style.transform !== "none";
    if (!hasTransform && escapeCount < Math.ceil(hosts.length * 0.5)) {
      return null;
    }
    // Only the nearest cluster root should promote — skip if a descendant
    // already owns a denser transformed clip gallery.
    for (const child of Array.from(element.children)) {
      if (!(child instanceof Element)) continue;
      const childStyle = getComputedStyle(child);
      if (childStyle.transform === "none") continue;
      const childHosts = collectUnsupportedClipPathHosts(child);
      if (childHosts.length >= 8) {
        return null;
      }
    }
    return { hosts };
  }

  function backdropCompositePaintRect(element: Element, fallback: DOMRect): DOMRect {
    let left = fallback.left;
    let top = fallback.top;
    let right = fallback.right;
    let bottom = fallback.bottom;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if ((text.nodeValue ?? "").trim() === "") {
        continue;
      }
      try {
        range.selectNodeContents(text);
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      } catch {
        // Ignore detached text nodes and keep the element border box.
      }
    }
    return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  }

  function clipPaintRectToAncestors(element: Element, paintRect: DOMRect): DOMRect {
    let left = paintRect.left;
    let top = paintRect.top;
    let right = paintRect.right;
    let bottom = paintRect.bottom;
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clipsX = clipsOverflow(ancestorStyle.overflowX);
      const clipsY = clipsOverflow(ancestorStyle.overflowY);
      if (!clipsX && !clipsY) continue;
      const ancestorRect = ancestor.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }
      if (clipsY) {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
      if (right <= left || bottom <= top) {
        return paintRect;
      }
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function paddingBoxRect(element: Element, style: CSSStyleDeclaration): DOMRect {
    const rect = element.getBoundingClientRect();
    const left = rect.left + parsePx(style.borderLeftWidth);
    const top = rect.top + parsePx(style.borderTopWidth);
    const right = rect.right - parsePx(style.borderRightWidth);
    const bottom = rect.bottom - parsePx(style.borderBottomWidth);
    return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  }

  function establishesAbsoluteContainingBlock(style: CSSStyleDeclaration): boolean {
    const contain = style.contain || "";
    const willChange = style.willChange || "";
    return (
      style.position !== "static" ||
      style.transform !== "none" ||
      style.filter !== "none" ||
      style.getPropertyValue("backdrop-filter") !== "none" ||
      style.perspective !== "none" ||
      contain.includes("layout") ||
      contain.includes("paint") ||
      contain.includes("strict") ||
      contain.includes("content") ||
      willChange.includes("transform")
    );
  }

  function generatedAbsoluteContainingBlock(
    element: Element,
    position: string,
  ): DOMRect {
    for (let candidate: Element | null = element; candidate !== null; candidate = candidate.parentElement) {
      const candidateStyle = getComputedStyle(candidate);
      if (establishesAbsoluteContainingBlock(candidateStyle)) {
        return paddingBoxRect(candidate, candidateStyle);
      }
      if (position === "fixed" && candidate !== element) {
        // Fixed positioning only uses an ancestor when that ancestor itself
        // establishes a fixed-position containing block through paint/layout.
        continue;
      }
    }
    return new DOMRect(
      -scrollX,
      -scrollY,
      document.documentElement.clientWidth,
      document.documentElement.clientHeight,
    );
  }

  function transformedBorderBoxRect(
    rect: DOMRect,
    style: CSSStyleDeclaration,
  ): DOMRect | null {
    const matrix = parseMatrix2d(style.transform);
    if (matrix === null) return null;
    const origin = parseTransformOrigin(style, rect.width, rect.height);
    if (origin === null) return null;
    const points = [
      { x: 0, y: 0 },
      { x: rect.width, y: 0 },
      { x: rect.width, y: rect.height },
      { x: 0, y: rect.height },
    ].map((point) => ({
      x:
        matrix.a * (point.x - origin.x) +
        matrix.c * (point.y - origin.y) +
        matrix.e +
        origin.x,
      y:
        matrix.b * (point.x - origin.x) +
        matrix.d * (point.y - origin.y) +
        matrix.f +
        origin.y,
    }));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = rect.left + Math.min(...xs);
    const top = rect.top + Math.min(...ys);
    const right = rect.left + Math.max(...xs);
    const bottom = rect.top + Math.max(...ys);
    return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  }

  function transformedPseudoPaintRect(
    element: Element,
    parentRect: DOMRect,
    parentStyle: CSSStyleDeclaration,
    which: "before" | "after",
    requireTransform = true,
  ): DOMRect | null {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(element, `::${which}`);
    } catch {
      return null;
    }
    if (
      !style.content ||
      style.content === "none" ||
      style.content === "normal" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      (requireTransform && style.transform === "none")
    ) {
      return null;
    }
    const size = pseudoBorderBoxSize(style);
    if (size.width <= 0 || size.height <= 0) return null;

    let left: number;
    let top: number;
    if (style.position === "absolute" || style.position === "fixed") {
      const containingBlock = generatedAbsoluteContainingBlock(element, style.position);
      if (style.left !== "auto") {
        left = containingBlock.left + parsePx(style.left) + parsePx(style.marginLeft);
      } else if (style.right !== "auto") {
        left =
          containingBlock.right -
          parsePx(style.right) -
          parsePx(style.marginRight) -
          size.width;
      } else {
        return null;
      }
      if (style.top !== "auto") {
        top = containingBlock.top + parsePx(style.top) + parsePx(style.marginTop);
      } else if (style.bottom !== "auto") {
        top =
          containingBlock.bottom -
          parsePx(style.bottom) -
          parsePx(style.marginBottom) -
          size.height;
      } else {
        return null;
      }
    } else {
      const fragments =
        parentStyle.display === "inline"
          ? Array.from(element.getClientRects()).filter(
              (fragment) => fragment.width > 0 && fragment.height > 0,
            )
          : [];
      const fragment = which === "before" ? fragments[0] : fragments.at(-1);
      left = fragment?.left ?? (which === "before" ? parentRect.left : parentRect.right - size.width);
      top = fragment?.top ?? parentRect.top;
    }
    const borderBox = new DOMRect(left, top, size.width, size.height);
    const paintRect =
      style.transform === "none" ? borderBox : transformedBorderBoxRect(borderBox, style);
    if (paintRect === null) return null;
    const blurMatch = /blur\((\d+(?:\.\d+)?)px\)/.exec(style.filter);
    const blurPx = blurMatch?.[1] === undefined ? 0 : Number.parseFloat(blurMatch[1]);
    return blurPx > 0 ? expandedFilterPaintRect(paintRect, blurPx) : paintRect;
  }

  function transformedPseudoFallbackRect(
    element: Element,
    parentRect: DOMRect,
    parentStyle: CSSStyleDeclaration,
  ): DOMRect {
    let left = parentRect.left;
    let top = parentRect.top;
    let right = parentRect.right;
    let bottom = parentRect.bottom;
    for (const which of ["before", "after"] as const) {
      const pseudoRect = transformedPseudoPaintRect(element, parentRect, parentStyle, which);
      if (pseudoRect === null) continue;
      left = Math.min(left, pseudoRect.left);
      top = Math.min(top, pseudoRect.top);
      right = Math.max(right, pseudoRect.right);
      bottom = Math.max(bottom, pseudoRect.bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function generatedPseudoFallbackRect(
    element: Element,
    parentRect: DOMRect,
    parentStyle: CSSStyleDeclaration,
  ): DOMRect {
    let left = parentRect.left;
    let top = parentRect.top;
    let right = parentRect.right;
    let bottom = parentRect.bottom;
    for (const which of ["before", "after"] as const) {
      const pseudoRect = transformedPseudoPaintRect(
        element,
        parentRect,
        parentStyle,
        which,
        false,
      );
      if (pseudoRect === null) continue;
      left = Math.min(left, pseudoRect.left);
      top = Math.min(top, pseudoRect.top);
      right = Math.max(right, pseudoRect.right);
      bottom = Math.max(bottom, pseudoRect.bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function requiresBackdropCompositeFallback(
    element: Element,
    style: CSSStyleDeclaration,
  ): boolean {
    const backdropFilter = style.getPropertyValue("backdrop-filter");
    if (
      backdropFilter !== "" &&
      backdropFilter !== "none" &&
      maskImageOf(style) !== "none"
    ) {
      // A masked backdrop-filter paints pixels from layers behind this
      // element. Treating it as an ordinary masked subtree makes screenshot
      // isolation hide the very backdrop the browser needs to composite.
      return true;
    }
    if (style.mixBlendMode !== "hard-light") {
      return false;
    }
    return true;
  }

  function backdropCompositeSourceElement(element: Element): Element | null {
    const source = element.previousElementSibling;
    if (source === null) {
      return null;
    }
    const targetStyle = getComputedStyle(element);
    if (!requiresBackdropCompositeFallback(element, targetStyle)) {
      return null;
    }
    const sourceStyle = getComputedStyle(source);
    const sourceRect = source.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();
    if (!isRenderable(source, sourceStyle, sourceRect)) {
      return null;
    }
    const tolerancePx = 1;
    const matchesBounds =
      Math.abs(sourceRect.left - targetRect.left) <= tolerancePx &&
      Math.abs(sourceRect.top - targetRect.top) <= tolerancePx &&
      Math.abs(sourceRect.width - targetRect.width) <= tolerancePx &&
      Math.abs(sourceRect.height - targetRect.height) <= tolerancePx;
    return matchesBounds ? source : null;
  }

  function isBackdropCompositeSourceElement(element: Element): boolean {
    const target = element.nextElementSibling;
    return target !== null && backdropCompositeSourceElement(target) === element;
  }

  function hasUnsupportedPseudoTransform(element: Element): boolean {
    for (const which of ["before", "after"] as const) {
      let style: CSSStyleDeclaration;
      try {
        style = getComputedStyle(element, `::${which}`);
      } catch {
        continue;
      }
      if (
        !style.content ||
        style.content === "none" ||
        style.content === "normal" ||
        style.display === "none" ||
        style.transform === "none"
      ) {
        continue;
      }
      const size = pseudoBorderBoxSize(style);
      const transformed = applyStructurallyRepresentablePseudoTransform(
        { x: 0, y: 0, width: size.width, height: size.height },
        style,
      );
      if (transformed === undefined) {
        return true;
      }
    }
    return false;
  }

  function hasBrowserResolvedGeneratedPseudoContent(element: Element): boolean {
    for (const which of ["before", "after"] as const) {
      let pseudoStyle: CSSStyleDeclaration;
      try {
        pseudoStyle = getComputedStyle(element, `::${which}`);
      } catch {
        continue;
      }
      if (
        !pseudoStyle.content ||
        pseudoStyle.content === "none" ||
        pseudoStyle.content === "normal" ||
        pseudoStyle.display === "none" ||
        pseudoStyle.visibility === "hidden" ||
        Number.parseFloat(pseudoStyle.opacity) === 0
      ) {
        continue;
      }
      if (!parseGeneratedContentText(pseudoStyle.content).complete) {
        return true;
      }
    }
    return false;
  }

  function unsupportedPseudoMaskKinds(element: Element): Array<"before" | "after"> {
    const kinds: Array<"before" | "after"> = [];
    for (const which of ["before", "after"] as const) {
      let pseudoStyle: CSSStyleDeclaration;
      try {
        pseudoStyle = getComputedStyle(element, `::${which}`);
      } catch {
        continue;
      }
      if (
        !pseudoStyle.content ||
        pseudoStyle.content === "none" ||
        pseudoStyle.content === "normal" ||
        pseudoStyle.display === "none"
      ) {
        continue;
      }
      if (requiresMaskedSubtreeFallback(pseudoStyle)) {
        kinds.push(which);
      }
    }
    return kinds;
  }

  function isThinDecorativeMaskedPseudo(
    element: Element,
    which: "before" | "after",
  ): boolean {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(element, `::${which}`);
    } catch {
      return false;
    }
    const size = pseudoBorderBoxSize(style);
    const thinDimension = Math.min(size.width, size.height);
    if (thinDimension <= 0 || thinDimension > 2) {
      return false;
    }
    const backdropFilter = style.getPropertyValue("backdrop-filter");
    return (
      (!style.filter || style.filter === "none") &&
      (!backdropFilter || backdropFilter === "none") &&
      (!style.boxShadow || style.boxShadow === "none") &&
      (!style.textShadow || style.textShadow === "none") &&
      (!style.outlineStyle || style.outlineStyle === "none")
    );
  }

  function walkScreenshotFallbackElement(
    element: Element,
    style: CSSStyleDeclaration,
    rect: DOMRect,
    fallbackLabel: string,
    warning: { code: string; detail: string },
  ): CaptureNode {
    // Clipped/transformed hosts often extend past overflow:hidden ancestors
    // (d3 hex gallery). Ancestor-clamping collapses their AABB to a sliver and
    // breaks screenshot placement; keep the element's own painted bounds.
    const visibleRect =
      fallbackLabel === "clipped-subtree" ||
      fallbackLabel === "transformed-subtree" ||
      fallbackLabel === "transformed-pseudo" ||
      fallbackLabel === "masked-pseudo" ||
      fallbackLabel === "external-svg-use" ||
      fallbackLabel === "svg-text" ||
      fallbackLabel === "svg-resource-paint"
        ? rect
        : clipPaintRectToAncestors(element, rect);
    nodeCount += 1;
    imageNodeCount += 1;
    const nodeId = nextNodeId();
    markForScreenshotFallback(element, nodeId);
    if (fallbackLabel === "backdrop-composite") {
      const source = backdropCompositeSourceElement(element);
      if (source !== null) {
        setCaptureMarker(source, "data-h2f-backdrop-source-for", nodeId);
      }
    }
    addWarning(warning.code, warning.detail, nodeId);
    const opacity = Number.parseFloat(style.opacity);
    return {
      id: nodeId,
      type: "image",
      tag: element.tagName.toLowerCase(),
      name: layerName(element),
      bounds: toPageRect(visibleRect),
      opacity: Number.isFinite(opacity) ? opacity : 1,
      clipsContent: false,
      assetMissing: true,
      fallbackLabel,
      scaleMode: "fill",
      ...extractStackingFacts(style, element.parentElement, element),
    };
  }

  function isDecorativeEffectScreenshotFallback(
    element: Element,
    fills: Paint[],
    blurPx: number | undefined,
    rotationDegrees: number | undefined,
  ): boolean {
    if (
      (blurPx ?? 0) < 16 ||
      fills.length !== 1 ||
      fills[0]?.type !== "radial-gradient"
    ) {
      return false;
    }
    if (rotationDegrees === undefined || rotationDegrees === 0) {
      return false;
    }
    return !hasRenderedDescendantPaint(element);
  }

  function hasRenderedDescendantPaint(element: Element): boolean {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    const range = document.createRange();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE) {
        try {
          range.selectNodeContents(node);
          if (
            Array.from(range.getClientRects()).some(
              (rect) => rect.width > 0.01 && rect.height > 0.01,
            )
          ) {
            return true;
          }
        } catch {
          // Detached text is not a current paint contribution.
        }
        continue;
      }
      const descendant = node as Element;
      const descendantStyle = getComputedStyle(descendant);
      const principalRect = descendant.getBoundingClientRect();
      const descendantRect =
        descendantStyle.display === "contents"
          ? displayContentsRenderedRect(descendant) ?? principalRect
          : principalRect;
      if (isRenderable(descendant, descendantStyle, descendantRect)) {
        return true;
      }
    }
    return false;
  }

  function hasVisibleOverlappingSiblingReplacement(
    element: Element,
    targetRect: DOMRect,
  ): boolean {
    const targetArea = Math.max(0, targetRect.width) * Math.max(0, targetRect.height);
    if (targetArea <= 0) {
      return false;
    }
    const visibleForPaint = (candidate: Element): boolean => {
      for (let current: Element | null = candidate; current !== null; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity) <= 0.01
        ) {
          return false;
        }
      }
      return true;
    };
    const hasBoxPaint = (style: CSSStyleDeclaration): boolean =>
      parseColor(style.backgroundColor) !== null ||
      style.backgroundImage !== "none" ||
      (style.boxShadow !== "none" && style.boxShadow !== "") ||
      (style.outlineStyle !== "none" && parsePx(style.outlineWidth) > 0) ||
      (style.borderTopStyle !== "none" && parsePx(style.borderTopWidth) > 0) ||
      (style.borderRightStyle !== "none" && parsePx(style.borderRightWidth) > 0) ||
      (style.borderBottomStyle !== "none" && parsePx(style.borderBottomWidth) > 0) ||
      (style.borderLeftStyle !== "none" && parsePx(style.borderLeftWidth) > 0);
    const pseudoHasPaint = (candidate: Element, which: "before" | "after"): boolean => {
      try {
        const style = getComputedStyle(candidate, `::${which}`);
        const content = style.content;
        if (
          !content ||
          content === "none" ||
          content === "normal" ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity) <= 0.01
        ) {
          return false;
        }
        return (
          (content !== '""' && content !== "''") ||
          hasBoxPaint(style) ||
          (style.textShadow !== "none" && style.textShadow !== "")
        );
      } catch {
        return false;
      }
    };
    const hasDirectPaint = (
      candidate: Element,
      style: CSSStyleDeclaration,
      rect: DOMRect,
    ): boolean => {
      if (rect.width <= 0.01 || rect.height <= 0.01) return false;
      if (candidate instanceof HTMLImageElement) {
        return candidate.complete && candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
      }
      if (candidate instanceof HTMLCanvasElement) {
        return rasterHasInk(candidate, candidate.width, candidate.height);
      }
      if (candidate instanceof HTMLVideoElement) {
        return (
          candidate.readyState >= 2 &&
          rasterHasInk(candidate, candidate.videoWidth || 1, candidate.videoHeight || 1)
        );
      }
      if (
        candidate instanceof SVGGraphicsElement ||
        candidate instanceof HTMLIFrameElement ||
        candidate instanceof HTMLEmbedElement ||
        candidate instanceof HTMLObjectElement
      ) {
        return true;
      }
      return hasBoxPaint(style) || pseudoHasPaint(candidate, "before") || pseudoHasPaint(candidate, "after");
    };
    const composedChildren = (candidate: Element): Element[] => {
      if (candidate instanceof HTMLSlotElement) {
        const assigned = candidate.assignedElements({ flatten: true });
        return assigned.length > 0 ? assigned : Array.from(candidate.children);
      }
      const shadowRoot = (candidate as HTMLElement).shadowRoot;
      return Array.from(shadowRoot?.children ?? candidate.children);
    };
    const hasVisiblePaint = (candidate: Element): boolean => {
      const pending: Element[] = [candidate];
      const range = document.createRange();
      let visited = 0;
      while (pending.length > 0 && visited < 250) {
        const current = pending.shift();
        if (current === undefined) continue;
        visited += 1;
        if (!visibleForPaint(current)) continue;
        const style = getComputedStyle(current);
        const rect = current.getBoundingClientRect();
        if (hasDirectPaint(current, style, rect)) return true;
        if (
          (parseColor(style.color) !== null ||
            (style.textShadow !== "none" && style.textShadow !== "")) &&
          Array.from(current.childNodes).some((node) => {
            if (node.nodeType !== Node.TEXT_NODE || !hasNonCollapsibleContent(node.nodeValue ?? "")) {
              return false;
            }
            try {
              range.selectNodeContents(node);
              return Array.from(range.getClientRects()).some(
                (textRect) => textRect.width > 0.01 && textRect.height > 0.01,
              );
            } catch {
              return false;
            }
          })
        ) {
          return true;
        }
        pending.push(...composedChildren(current));
      }
      return false;
    };
    const overlapFraction = (candidateRect: DOMRect): number => {
      const overlapWidth = Math.max(
        0,
        Math.min(targetRect.right, candidateRect.right) -
          Math.max(targetRect.left, candidateRect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(targetRect.bottom, candidateRect.bottom) -
          Math.max(targetRect.top, candidateRect.top),
      );
      const overlapArea = overlapWidth * overlapHeight;
      const candidateArea = Math.max(0, candidateRect.width) * Math.max(0, candidateRect.height);
      return Math.min(targetArea, candidateArea) > 0
        ? overlapArea / Math.min(targetArea, candidateArea)
        : 0;
    };

    /**
     * A static poster is often kept as the first absolute sibling underneath
     * a live scene. Geometry alone cannot distinguish that authored fallback
     * from a state that actually replaces the marked box: both rectangles are
     * the same size. Ask Chromium's hit-test stack at several points in the
     * intersection and only accept a sibling that paints above the marked
     * element. This also preserves the conservative behavior for
     * pointer-events:none artwork (it is not promoted unless the browser can
     * prove the stacking relationship).
     */
    const paintsAboveTarget = (candidate: Element, candidateRect: DOMRect): boolean => {
      const left = Math.max(targetRect.left, candidateRect.left);
      const right = Math.min(targetRect.right, candidateRect.right);
      const top = Math.max(targetRect.top, candidateRect.top);
      const bottom = Math.min(targetRect.bottom, candidateRect.bottom);
      if (right <= left || bottom <= top) return false;
      const x25 = left + (right - left) * 0.25;
      const x50 = left + (right - left) * 0.5;
      const x75 = left + (right - left) * 0.75;
      const y25 = top + (bottom - top) * 0.25;
      const y50 = top + (bottom - top) * 0.5;
      const y75 = top + (bottom - top) * 0.75;
      const points: Array<[number, number]> = [
        [x50, y50],
        [x25, y25],
        [x75, y25],
        [x25, y75],
        [x75, y75],
      ];
      const countAbove = (): { count: number; missingHit: boolean } => {
        let count = 0;
        let missingHit = false;
        for (const [x, y] of points) {
          let stack: Element[];
          try {
            stack = document.elementsFromPoint(x, y);
          } catch {
            continue;
          }
          const candidateIndex = stack.findIndex(
            (hit) => hit === candidate || candidate.contains(hit),
          );
          const targetIndex = stack.findIndex((hit) => hit === element || element.contains(hit));
          if (candidateIndex < 0 || targetIndex < 0) {
            missingHit = true;
            continue;
          }
          if (candidateIndex < targetIndex) count += 1;
        }
        return { count, missingHit };
      };
      const initial = countAbove();
      if (initial.count >= 2 || !initial.missingHit) {
        return initial.count >= 2;
      }

      // `elementsFromPoint` honors pointer-events. Some WebGL hosts disable
      // hit testing even though their pixels are painted; temporarily making
      // just the two measured branches hit-testable lets Chromium expose the
      // same stacking order without changing layout or computed paint.
      const styleSnapshots = [element, candidate].map((branch) => ({
        branch,
        style: branch.getAttribute("style"),
      }));
      try {
        for (const branch of [element, candidate]) {
          (branch as Element & { style: CSSStyleDeclaration }).style.setProperty(
            "pointer-events",
            "auto",
            "important",
          );
        }
        return countAbove().count >= 2;
      } finally {
        for (const snapshot of styleSnapshots) {
          if (snapshot.style === null) snapshot.branch.removeAttribute("style");
          else snapshot.branch.setAttribute("style", snapshot.style);
        }
      }
    };

    // Some rotators keep every word state inside one shared wrapper instead
    // of swapping sibling wrappers (Shopify's hero is one example). A
    // viewport-state marker on that wrapper is stale as soon as one of its
    // descendants is visibly painted again. Keep the wrapper structural so
    // its live text remains editable and, importantly, avoid baking a
    // transparent text layer against the page's black fallback backdrop.
    for (const candidate of Array.from(element.querySelectorAll("*"))
      .slice(0, 250)
      .filter((entry) => entry !== element)) {
      const candidateRect = candidate.getBoundingClientRect();
      const candidateArea = Math.max(0, candidateRect.width) * Math.max(0, candidateRect.height);
      if (
        // A returned rotator state spans the marked visual slot. A small
        // persistent label inside a much taller degraded container does not:
        // treating it as a replacement would drop the collapsed content that
        // caused the viewport fallback in the first place.
        candidateArea < targetArea * 0.5 ||
        candidateArea > targetArea * 2 ||
        overlapFraction(candidateRect) < 0.8
      ) {
        continue;
      }
      const style = getComputedStyle(candidate);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity) <= 0.01
      ) {
        continue;
      }
      if (hasVisiblePaint(candidate)) {
        return true;
      }
    }

    // Rotators commonly put each absolutely-positioned state in a zero-height
    // sibling wrapper. Walk a small composed ancestor window and compare both
    // wrappers and their painted descendants against the marked state box.
    let ancestor: Element | null = element;
    for (let depth = 0; ancestor !== null && depth < 3; depth += 1) {
      const parent: Element | null = ancestor.parentElement;
      if (parent === null) break;
      const siblings: Element[] = Array.from(parent.children);
      for (const sibling of siblings) {
        if (
          sibling === ancestor ||
          sibling === element ||
          sibling.contains(element) ||
          element.contains(sibling)
        ) {
          continue;
        }
        const candidates: Element[] = [
          sibling,
          ...Array.from(sibling.querySelectorAll("*")),
        ].slice(0, 250);
        for (const candidate of candidates) {
          const candidateRect = candidate.getBoundingClientRect();
          const candidateArea = Math.max(0, candidateRect.width) * Math.max(0, candidateRect.height);
          if (
            candidateArea < targetArea * 0.5 ||
            candidateArea > targetArea * 2 ||
            overlapFraction(candidateRect) < 0.8
          ) {
            continue;
          }
          const style = getComputedStyle(candidate);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity) <= 0.01
          ) {
            continue;
          }
          if (hasVisiblePaint(candidate) && paintsAboveTarget(candidate, candidateRect)) {
            return true;
          }
        }
      }
      ancestor = parent;
    }
    return false;
  }

  function requiresTransformedFilteredSubtreeFallback(
    element: Element,
    blurPx: number | undefined,
    rotationDegrees: number | undefined,
  ): boolean {
    return (
      (blurPx ?? 0) > 0 &&
      rotationDegrees !== undefined &&
      rotationDegrees !== 0 &&
      hasRenderedDescendantPaint(element)
    );
  }

  function requiresTransformedSubtreeFallback(
    element: Element,
    rotationDegrees: number | undefined,
  ): boolean {
    return (
      rotationDegrees !== undefined &&
      rotationDegrees !== 0 &&
      hasRenderedDescendantPaint(element)
    );
  }

  function expandedFilterPaintRect(rect: DOMRect, blurPx: number): DOMRect {
    const padding = Math.ceil(blurPx * 3);
    return new DOMRect(
      rect.x - padding,
      rect.y - padding,
      rect.width + padding * 2,
      rect.height + padding * 2,
    );
  }

  function walkCanvas(element: HTMLCanvasElement, style: CSSStyleDeclaration, rect: DOMRect): CaptureNode | null {
    nodeCount += 1;
    imageNodeCount += 1;
    // Always defer to the engine's element screenshot. In-page drawImage
    // readback returns the raw buffer, which for WebGL shaders (noise
    // effects, post-processed scenes) differs wildly from the composited
    // pixels on screen. The screenshot is what the user actually sees.
    const nodeId = nextNodeId();
    markForScreenshotFallback(element, nodeId);
    addWarning("canvas_rasterized", "screenshot fallback", nodeId);
    return {
      id: nodeId,
      type: "image",
      tag: "canvas",
      name: layerName(element),
      bounds: toPageRect(rect),
      opacity: Number.parseFloat(style.opacity) || 1,
      clipsContent: false,
      assetMissing: true,
      scaleMode: "fill",
    };
  }

  function requiresLayeredCanvasCompositeFallback(element: Element, rect: DOMRect): boolean {
    if (element instanceof HTMLCanvasElement || rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    for (let index = 0; index < element.childNodes.length; index += 1) {
      const child = element.childNodes.item(index);
      if (
        child?.nodeType === Node.TEXT_NODE &&
        hasNonCollapsibleContent(child.nodeValue ?? "")
      ) {
        return false;
      }
    }

    const canvasRects: DOMRect[] = [];
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children.item(index);
      if (!child) continue;
      const childStyle = getComputedStyle(child);
      const childRect = child.getBoundingClientRect();
      if (!isRenderable(child, childStyle, childRect)) continue;
      if (child instanceof HTMLCanvasElement) {
        canvasRects.push(childRect);
        continue;
      }
      // A layered scene may add a text-free SVG/image effect above its
      // canvases (Earth Nullschool's spotlight mask is one example). It is
      // still part of the final browser composite; interactive/textual DOM
      // siblings keep the subtree structural instead.
      if (
        !(child instanceof SVGSVGElement || child instanceof HTMLImageElement) ||
        hasNonCollapsibleContent(child.textContent ?? "")
      ) {
        return false;
      }
    }
    if (canvasRects.length < 2) return false;

    // Browser-box fact: only collapse a true layered scene, where at least
    // two direct canvases substantially cover the same parent surface. This
    // excludes dashboards containing independent side-by-side charts.
    const parentArea = rect.width * rect.height;
    let coveringCanvasCount = 0;
    for (const canvasRect of canvasRects) {
      const overlapWidth = Math.max(
        0,
        Math.min(rect.right, canvasRect.right) - Math.max(rect.left, canvasRect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(rect.bottom, canvasRect.bottom) - Math.max(rect.top, canvasRect.top),
      );
      if ((overlapWidth * overlapHeight) / parentArea >= 0.8) {
        coveringCanvasCount += 1;
      }
    }
    return coveringCanvasCount >= 2;
  }

  function requiresPositionedGradientFallback(style: CSSStyleDeclaration): boolean {
    if (!style.backgroundImage || style.backgroundImage === "none") return false;
    const layers = splitTopLevel(style.backgroundImage, ",");
    const sizes = splitTopLevel(style.backgroundSize || "auto", ",");
    for (let index = 0; index < layers.length; index += 1) {
      const layer = layers[index] ?? "";
      if (!layer.includes("gradient(")) continue;
      const size = valueForBackgroundLayer(sizes, index, "auto")
        .trim()
        .replace(/\s+/g, " ");
      if (size !== "auto" && size !== "auto auto" && size !== "100% 100%") {
        return true;
      }
    }
    return false;
  }

  function syntheticTextChild(text: string, style: TextStyle, bounds: PageRect): CaptureNode {
    textNodeCount += 1;
    nodeCount += 1;
    return {
      id: nextNodeId(),
      type: "text",
      tag: "#text",
      name: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      bounds,
      opacity: 1,
      clipsContent: false,
      text,
      segments: [{ text, style }],
      style,
    };
  }

  function walkElement(element: Element): CaptureNode | null {
    if (nodeCount >= maxNodes) {
      truncated = true;
      return null;
    }
    const style = getComputedStyle(element);
    const principalRect = element.getBoundingClientRect();
    const rect =
      style.display === "contents"
        ? displayContentsRenderedRect(element) ?? principalRect
        : principalRect;
    if (!isRenderable(element, style, rect)) {
      return null;
    }

    if (element.hasAttribute("data-h2f-viewport-state-shot")) {
      // A rotating viewport state may leave the old wrapper marked after a
      // same-sized sibling has become the browser-visible replacement. The
      // replacement must be extracted as ordinary DOM; rasterizing the old
      // wrapper produces an empty/background-only tile and drops the live
      // words (Shopify hero rotator).
      if (!hasVisibleOverlappingSiblingReplacement(element, rect)) {
        return walkScreenshotFallbackElement(
          element,
          style,
          rect,
          "viewport-dependent-content",
          {
            code: "animation_mid_state",
            detail: "viewport state degraded after full-page scan; screenshot fallback",
          },
        );
      }
    }
    if (requiresBackdropCompositeFallback(element, style)) {
      const backdropFilter = style.getPropertyValue("backdrop-filter");
      const isMaskedBackdropFilter =
        backdropFilter !== "" &&
        backdropFilter !== "none" &&
        maskImageOf(style) !== "none";
      return walkScreenshotFallbackElement(
        element,
        style,
        backdropCompositePaintRect(element, rect),
        "backdrop-composite",
        {
          code: "unsupported_paint",
          detail: isMaskedBackdropFilter
            ? "masked backdrop-filter requires browser backdrop compositing; screenshot fallback"
            : "hard-light text requires browser backdrop compositing; screenshot fallback",
        },
      );
    }
    if (requiresMaskedSubtreeFallback(style)) {
      return walkScreenshotFallbackElement(element, style, rect, "masked-subtree", {
        code: "unsupported_paint",
        detail: `mask-image ${maskImageOf(style).slice(0, 80)}; screenshot fallback`,
      });
    }
    if (requiresUnsupportedClipPathFallback(style, rect)) {
      return walkScreenshotFallbackElement(element, style, rect, "clipped-subtree", {
        code: "unsupported_paint",
        detail: `clip-path ${style.clipPath.trim().slice(0, 80)}; screenshot fallback`,
      });
    }
    const clippedCluster = requiresClippedSubtreeClusterFallback(element, style);
    if (clippedCluster !== null) {
      const clusterRect = clippedSubtreeClusterPaintRect(
        element,
        clippedCluster.hosts,
        rect,
      );
      if (clusterRect.width > 1 && clusterRect.height > 1) {
        return walkScreenshotFallbackElement(
          element,
          style,
          clusterRect,
          "clipped-subtree",
          {
            code: "unsupported_paint",
            detail: `clip-path cluster (${clippedCluster.hosts.length} hosts); screenshot fallback`,
          },
        );
      }
    }
    if (hasUnsupportedPseudoTransform(element)) {
      return walkScreenshotFallbackElement(
        element,
        style,
        transformedPseudoFallbackRect(element, rect, style),
        "transformed-pseudo",
        {
          code: "unsupported_transform",
          detail: "pseudo-element transform cannot be represented structurally; screenshot fallback",
        },
      );
    }
    if (hasBrowserResolvedGeneratedPseudoContent(element)) {
      return walkScreenshotFallbackElement(
        element,
        style,
        generatedPseudoFallbackRect(element, rect, style),
        "generated-pseudo",
        {
          code: "unsupported_paint",
          detail:
            "browser-resolved pseudo-element content cannot be represented structurally; screenshot fallback",
        },
      );
    }
    const unsupportedPseudoMasks = unsupportedPseudoMaskKinds(element);
    const omittedThinMaskedPseudos = new Set(
      unsupportedPseudoMasks.filter((which) =>
        isThinDecorativeMaskedPseudo(element, which),
      ),
    );
    if (
      unsupportedPseudoMasks.length > 0 &&
      omittedThinMaskedPseudos.size !== unsupportedPseudoMasks.length
    ) {
      // Next.js Powered By cards: ::before uses dual linear-gradient masks +
      // mask-composite:exclude as a 1px conic border. Without the mask, the
      // opaque conic fill covers the card content.
      return walkScreenshotFallbackElement(element, style, rect, "masked-pseudo", {
        code: "unsupported_paint",
        detail:
          "pseudo-element mask-composite/mask-image cannot be represented structurally; screenshot fallback",
      });
    }
    if (requiresLayeredCanvasCompositeFallback(element, rect)) {
      return walkScreenshotFallbackElement(
        element,
        style,
        rect,
        "layered-canvas-composite",
        {
          code: "canvas_rasterized",
          detail: "overlapping canvas siblings require browser compositing",
        },
      );
    }
    if (requiresPositionedGradientFallback(style)) {
      // Leaf / empty hosts can safely become a screenshot image. A container
      // with element children (especially html/body) must keep its subtree —
      // replacing it with type:"image" drops every descendant, and a non-element
      // root is then discarded for an empty synthetic body (Steam store).
      const tagName = element.tagName.toLowerCase();
      const isDocumentShell = tagName === "html" || tagName === "body";
      const hasElementChildren = element.childElementCount > 0;
      if (!isDocumentShell && !hasElementChildren) {
        return walkScreenshotFallbackElement(element, style, rect, "positioned-gradient", {
          code: "unsupported_paint",
          detail: `gradient background-size ${style.backgroundSize}; screenshot fallback`,
        });
      }
      addWarning(
        "unsupported_paint",
        `gradient background-size ${style.backgroundSize}; retained structural tree`,
      );
    }

    if (
      style.filter !== "none" &&
      (element instanceof HTMLImageElement ||
        element instanceof SVGSVGElement ||
        element instanceof HTMLCanvasElement ||
        element instanceof HTMLVideoElement)
    ) {
      return walkScreenshotFallbackElement(element, style, rect, "filtered-media", {
        code: "unsupported_paint",
        detail: `CSS filter ${style.filter.slice(0, 80)} requires browser-composited pixels`,
      });
    }

    if (element instanceof HTMLImageElement) {
      return walkImage(element, style, rect);
    }
    if (element instanceof SVGSVGElement) {
      return walkSvg(element, style, rect);
    }
    if (element instanceof HTMLCanvasElement) {
      return walkCanvas(element, style, rect);
    }
    if (element instanceof HTMLIFrameElement) {
      nodeCount += 1;
      imageNodeCount += 1;
      // Iframe content is inaccessible cross-origin, but it is painted in the
      // page, so the engine screenshot fallback captures it faithfully.
      const nodeId = nextNodeId();
      markForScreenshotFallback(element, nodeId);
      addWarning("cross_origin_frame_skipped", "screenshot fallback", nodeId);
      return {
        id: nodeId,
        type: "image",
        tag: "iframe",
        name: layerName(element),
        bounds: toPageRect(rect),
        opacity: 1,
        clipsContent: false,
        scaleMode: "fill",
        assetMissing: true,
      };
    }
    if (element instanceof HTMLVideoElement) {
      nodeCount += 1;
      imageNodeCount += 1;
      // Best fidelity first: grab the currently displayed frame. Falls back
      // to the poster image, then to the engine screenshot fallback.
      const frameWidth = element.videoWidth || Math.round(rect.width);
      const frameHeight = element.videoHeight || Math.round(rect.height);
      const frameDataUrl =
        element.readyState >= 2 ? grabElementFrame(element, frameWidth, frameHeight) : null;
      if (frameDataUrl !== null) {
        const nodeId = nextNodeId();
        addWarning("video_replaced_with_poster", "current frame", nodeId);
        return {
          id: nodeId,
          type: "image",
          tag: "video",
          name: layerName(element),
          bounds: toPageRect(rect),
          opacity: Number.parseFloat(style.opacity) || 1,
          clipsContent: false,
          scaleMode: "fill",
          assetId: registerInlineAsset("raster-image", frameDataUrl, "image/png", frameWidth, frameHeight),
          naturalWidth: frameWidth,
          naturalHeight: frameHeight,
        };
      }
      const poster = element.poster ? resolveUrl(element.poster) : null;
      if (poster !== null) {
        const nodeId = nextNodeId();
        addWarning("video_replaced_with_poster", undefined, nodeId);
        return {
          id: nodeId,
          type: "image",
          tag: "video",
          name: layerName(element),
          bounds: toPageRect(rect),
          opacity: 1,
          clipsContent: false,
          scaleMode: "fill",
          assetId: registerRemoteAsset(poster, "raster-image"),
        };
      }
      const nodeId = nextNodeId();
      markForScreenshotFallback(element, nodeId);
      addWarning("video_replaced_with_poster", "screenshot fallback", nodeId);
      return {
        id: nodeId,
        type: "image",
        tag: "video",
        name: layerName(element),
        bounds: toPageRect(rect),
        opacity: 1,
        clipsContent: false,
        scaleMode: "fill",
        assetMissing: true,
      };
    }

    nodeCount += 1;
    // display:contents has no principal CSS box. Its descendant union is only
    // a structural frame for downstream coordinates; background, borders,
    // shadows, clipping and padding on the wrapper do not paint in Chromium.
    const hasPrincipalBox = style.display !== "contents";
    const nodeBorders = hasPrincipalBox ? extractBorders(style) : undefined;
    const nodeCornerRadii = hasPrincipalBox
      ? extractCornerRadii(style, rect.width, rect.height)
      : undefined;
    const nodeShadows = hasPrincipalBox ? extractShadows(style) : undefined;
    const nodeClipBounds = hasPrincipalBox
      ? extractRectangularClipBounds(style, rect)
      : undefined;
    const nodeLayout = hasPrincipalBox ? extractLayoutHint(style) : undefined;
    const nodePadding = hasPrincipalBox ? extractPadding(style) : undefined;
    // filter blur: decorative glow elements (e.g. a pill with blur(120px)
    // at low opacity) look like hard solid shapes if the blur is dropped,
    // so it must be carried through to a layer blur. backdrop-filter blur
    // is a DIFFERENT effect (frosted glass: blurs what's BEHIND, not the
    // element itself) and must map to a background blur, never layer blur.
    const blurMatch = /blur\((\d+(?:\.\d+)?)px\)/.exec(style.filter);
    const nodeBlurPx =
      blurMatch?.[1] !== undefined ? Number.parseFloat(blurMatch[1]) : undefined;
    const backdropMatch = /blur\((\d+(?:\.\d+)?)px\)/.exec(
      style.getPropertyValue("backdrop-filter"),
    );
    const nodeBackdropBlurPx =
      backdropMatch?.[1] !== undefined ? Number.parseFloat(backdropMatch[1]) : undefined;
    const nodeFills = hasPrincipalBox ? extractFills(style, rect.width, rect.height) : [];
    const rotation = extractRotation(style);
    if (requiresTransformedFilteredSubtreeFallback(element, nodeBlurPx, rotation)) {
      const nodeId = nextNodeId();
      imageNodeCount += 1;
      markForScreenshotFallback(element, nodeId);
      addWarning(
        "unsupported_transform",
        "rotated filtered subtree requires browser-composited screenshot fallback",
        nodeId,
      );
      return {
        id: nodeId,
        type: "image",
        tag: element.tagName.toLowerCase(),
        name: layerName(element),
        bounds: toPageRect(expandedFilterPaintRect(rect, nodeBlurPx ?? 0)),
        opacity: 1,
        clipsContent: false,
        assetMissing: true,
        fallbackLabel: "decorative-effect",
        scaleMode: "fill",
        createsStackingContext: true,
      };
    }
    if (requiresTransformedSubtreeFallback(element, rotation)) {
      return walkScreenshotFallbackElement(
        element,
        style,
        rect,
        "transformed-subtree",
        {
          code: "unsupported_transform",
          detail: "transformed subtree with descendant paint requires browser-composited screenshot fallback",
        },
      );
    }
    if (isDecorativeEffectScreenshotFallback(element, nodeFills, nodeBlurPx, rotation)) {
      const nodeId = nextNodeId();
      imageNodeCount += 1;
      markForScreenshotFallback(element, nodeId);
      addWarning(
        "unsupported_filter",
        "rotated blurred decoration requires browser-composited screenshot fallback",
        nodeId,
      );
      return {
        id: nodeId,
        type: "image",
        tag: element.tagName.toLowerCase(),
        name: layerName(element),
        bounds: toPageRect(rect),
        opacity: 1,
        clipsContent: false,
        assetMissing: true,
        fallbackLabel: "decorative-effect",
        scaleMode: "fill",
      };
    }
    const clipsBothAxes = clipsOverflow(style.overflowX) && clipsOverflow(style.overflowY);
    const positionedClipEscape =
      clipsBothAxes && hasVisiblePositionedClipEscape(element, rect);
    const elementNodeId = nextNodeId();
    const elementNode: CaptureElementNode = {
      id: elementNodeId,
      type: "element",
      tag: element.tagName.toLowerCase(),
      name: layerName(element),
      bounds: toPageRect(rect),
      opacity: Number.parseFloat(style.opacity) || 1,
      // Clipping fact: auto/scroll containers clip to the scrollport just like
      // hidden/clip. Without this fact, downstream rendering expands a long
      // scrollable list such as an MDN sidebar across the entire page.
      clipsContent: clipsBothAxes && !positionedClipEscape,
      fills: nodeFills,
      ...(nodeBorders !== undefined ? { borders: nodeBorders } : {}),
      ...(nodeCornerRadii !== undefined ? { cornerRadii: nodeCornerRadii } : {}),
      ...(nodeShadows !== undefined ? { shadows: nodeShadows } : {}),
      ...(nodeClipBounds !== undefined ? { clipBounds: nodeClipBounds } : {}),
      ...(nodeLayout !== undefined ? { layout: nodeLayout } : {}),
      ...(nodePadding !== undefined ? { padding: nodePadding } : {}),
      ...(nodeBlurPx !== undefined && nodeBlurPx > 0 ? { blurPx: nodeBlurPx } : {}),
      ...(nodeBackdropBlurPx !== undefined && nodeBackdropBlurPx > 0
        ? { backdropBlurPx: nodeBackdropBlurPx }
        : {}),
      ...extractStackingFacts(style, element.parentElement, element),
      children: [],
    };
    if (omittedThinMaskedPseudos.size > 0) {
      addWarning(
        "unsupported_paint",
        `thin masked pseudo-element omitted (${Array.from(omittedThinMaskedPseudos)
          .map((which) => `::${which}`)
          .join(", ")})`,
        elementNodeId,
      );
    }
    if (nodeFills.some((fill) => fill.type === "image")) {
      const elementBindings =
        ((window as unknown as Record<string, unknown>).__h2fElementElements as
          | Map<string, Element>
          | undefined) ?? new Map<string, Element>();
      elementBindings.set(elementNodeId, element);
      (window as unknown as Record<string, unknown>).__h2fElementElements = elementBindings;
      try {
        setCaptureMarker(element, "data-h2f-background-shot", elementNodeId);
      } catch {
        // A failed background request will keep the normal missing-paint path
        // if this host cannot be bound for a browser screenshot.
      }
    }
    if (rotation !== undefined) {
      elementNode.rotationDegrees = rotation;
    }
    if (style.mixBlendMode && style.mixBlendMode !== "normal") {
      elementNode.mixBlendMode = style.mixBlendMode;
    }
    // Single-axis clipping fact. clipsContent represents two-axis clipping, so
    // one-axis overflow is recorded separately.
    const clipsX = clipsOverflow(style.overflowX);
    const clipsY = clipsOverflow(style.overflowY);
    if (clipsX !== clipsY) {
      elementNode.clipAxes = { x: clipsX, y: clipsY };
    }
    // Animation fact: the computed style at capture time represents an
    // intermediate animation frame rather than the resting state.
    if (style.animationName !== "none" && style.animationPlayState === "running") {
      elementNode.animationState = "running";
    }
    // For rotated elements, bounds is the transformed AABB. Also record the
    // untransformed layout box centered on that AABB so downstream consumers
    // can restore rotation without reverse-solving the AABB.
    if (rotation !== undefined && element instanceof HTMLElement) {
      const lw = element.offsetWidth;
      const lh = element.offsetHeight;
      if (lw > 0 && lh > 0) {
        const cx = rect.left + scrollX + rect.width / 2;
        const cy = rect.top + scrollY + rect.height / 2;
        elementNode.layoutBounds = {
          x: cx - lw / 2,
          y: cy - lh / 2,
          width: lw,
          height: lh,
        };
      }
    }
    // Inline fragment fact. When a painted inline element such as a <code> chip
    // wraps, bounds is an AABB spanning multiple lines; painting that box would
    // create a wide band across the row. el.getClientRects() directly measures
    // each browser line fragment. Record it only for two or more fragments so
    // downstream consumers can paint every fragment separately.
    if (
      style.display === "inline" &&
      (nodeFills.length > 0 || nodeBorders !== undefined)
    ) {
      const clientRects = element.getClientRects();
      if (clientRects.length > 1) {
        const frags: PageRect[] = [];
        for (let i = 0; i < clientRects.length; i += 1) {
          const fr = clientRects.item(i);
          if (fr && fr.width > 0 && fr.height > 0) {
            frags.push({
              x: fr.left + scrollX,
              y: fr.top + scrollY,
              width: fr.width,
              height: fr.height,
            });
          }
        }
        if (frags.length > 1) {
          elementNode.fragmentRects = frags;
          const decorationBreak =
            style.getPropertyValue("box-decoration-break") ||
            style.getPropertyValue("-webkit-box-decoration-break");
          if (decorationBreak === "slice" || decorationBreak === "clone") {
            elementNode.boxDecorationBreak = decorationBreak;
          }
          if (
            style.writingMode === "horizontal-tb" &&
            (style.direction === "ltr" || style.direction === "rtl")
          ) {
            elementNode.fragmentInlineDirection = style.direction;
          }
        }
      }
    }
    // Extract ::marker because list bullets and counters are browser-generated
    // boxes absent from the DOM. Read type, color, and font size from computed
    // ::marker style. No DOM API exposes the box position for outside markers,
    // so derive it from CSS rules and a Chromium UA constant (see the function
    // documentation).
    const markerNode = walkListMarker(element, rect, style);
    if (markerNode) {
      elementNode.children.push(markerNode);
    }
    // Extract pseudo-elements with ::before preceding children and ::after
    // following them as an approximation of paint order.
    const beforeNode = omittedThinMaskedPseudos.has("before")
      ? null
      : walkPseudoElement(element, rect, "before", style);
    if (beforeNode) {
      elementNode.children.push(beforeNode);
    }
    const beforeFlowEnd = (() => {
      if (beforeNode === null || beforeNode.type !== "element") return undefined;
      const beforeStyle = getComputedStyle(element, "::before");
      if (
        beforeStyle.position === "absolute" ||
        beforeStyle.position === "fixed" ||
        beforeStyle.display === "block" ||
        style.writingMode !== "horizontal-tb"
      ) return undefined;
      const contentLeft =
        rect.left + parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft) + scrollX;
      return (
        contentLeft +
        parsePx(beforeStyle.marginLeft) +
        pseudoBorderBoxSize(beforeStyle).width +
        parsePx(beforeStyle.marginRight)
      );
    })();
    let beforeFlowAdvancePending = beforeFlowEnd !== undefined;

    // Form control synthetic text (value/placeholder).
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      let value = element.value;
      if (!value && element.placeholder) {
        // Floating-label patterns (e.g. GitHub's hero email input) hide the
        // native placeholder via `::placeholder { opacity: 0 }` and overlay
        // a visible <label> instead. Rendering the hidden placeholder would
        // duplicate the label text, so only use it when actually visible.
        const placeholderStyle = window.getComputedStyle(element, "::placeholder");
        const placeholderOpacity = Number.parseFloat(placeholderStyle.opacity);
        const placeholderColor = parseColor(placeholderStyle.color);
        const placeholderVisible =
          (!Number.isFinite(placeholderOpacity) || placeholderOpacity > 0.01) &&
          (placeholderColor === null || placeholderColor.a > 0.01);
        if (placeholderVisible) {
          value = element.placeholder;
        }
      }
      if (value && rect.width > 0 && rect.height > 0) {
        const textStyle = extractTextStyle(style);
        if (!element.value && element.placeholder) {
          textStyle.color = { ...textStyle.color, a: textStyle.color.a * 0.55 };
        }
        const padding = extractPadding(style);
        const paddingTop = padding?.top ?? 0;
        const paddingRight = padding?.right ?? 8;
        const paddingBottom = padding?.bottom ?? 0;
        const paddingLeft = padding?.left ?? 8;
        const borderTop = parsePx(style.borderTopWidth);
        const borderRight = parsePx(style.borderRightWidth);
        const borderBottom = parsePx(style.borderBottomWidth);
        const borderLeft = parsePx(style.borderLeftWidth);
        const contentHeight = Math.max(
          0,
          rect.height - borderTop - borderBottom - paddingTop - paddingBottom,
        );
        const bounds: PageRect = {
          x: rect.left + scrollX + borderLeft + paddingLeft,
          y:
            rect.top +
            scrollY +
            borderTop +
            paddingTop +
            Math.max(0, (contentHeight - textStyle.lineHeightPx) / 2),
          width: Math.max(
            0,
            rect.width - borderLeft - borderRight - paddingLeft - paddingRight,
          ),
          height: textStyle.lineHeightPx,
        };
        elementNode.children.push(syntheticTextChild(value, textStyle, bounds));
      }
      return elementNode;
    }
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions.item(0);
      if (selected && selected.textContent) {
        const textStyle = extractTextStyle(style);
        const bounds: PageRect = {
          x: rect.left + scrollX + 12,
          y: rect.top + scrollY + Math.max(0, (rect.height - textStyle.lineHeightPx) / 2),
          width: Math.max(0, rect.width - 24),
          height: textStyle.lineHeightPx,
        };
        elementNode.children.push(
          syntheticTextChild(selected.textContent.trim(), textStyle, bounds),
        );
      }
      return elementNode;
    }

    // Walk children, grouping inline text runs.
    const preserveWhitespace = style.whiteSpace.startsWith("pre");
    let currentRun: TextRunPiece[] = [];

    function flushRun(): void {
      const textNode = buildTextNode(currentRun, style);
      if (textNode) {
        if (
          beforeFlowAdvancePending &&
          beforeFlowEnd !== undefined &&
          textNode.bounds.x < beforeFlowEnd
        ) {
          const delta = beforeFlowEnd - textNode.bounds.x;
          textNode.bounds = { ...textNode.bounds, x: textNode.bounds.x + delta };
          if (textNode.type === "text" && textNode.measuredLines !== undefined) {
            textNode.measuredLines = textNode.measuredLines.map((line) => ({
              ...line,
              x: line.x + delta,
            }));
          }
        }
        beforeFlowAdvancePending = false;
        elementNode.children.push(textNode);
      }
      currentRun = [];
    }

    function collectInline(container: Element | ShadowRoot): void {
      processChildList(Array.from(container.childNodes));
    }

    function processChildList(children: Node[]): void {
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE) {
          const raw = child.nodeValue ?? "";
          if (!hasNonCollapsibleContent(raw) && currentRun.length === 0) {
            continue;
          }
          const parentElement = child.parentElement;
          if (!parentElement) {
            continue;
          }
          const parentStyle = getComputedStyle(parentElement);
          if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
            continue;
          }
          const text = collapseWhitespace(raw, preserveWhitespace);
          if (text.length === 0) {
            continue;
          }
          currentRun.push({
            node: child as Text,
            text,
            style: extractTextStyle(parentStyle),
          });
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        const childElement = child as Element;
        if (isBackdropCompositeSourceElement(childElement)) {
          flushRun();
          continue;
        }
        if (childElement.tagName === "SLOT") {
          // Composed-tree traversal: slotted light-DOM content renders where
          // the slot sits, so process assigned nodes in place (falling back
          // to the slot's default content when nothing is assigned).
          processChildList(
            (childElement as HTMLSlotElement).assignedNodes({ flatten: true }),
          );
          continue;
        }
        if (childElement.tagName === "BR") {
          // Keep run; Figma text will wrap naturally by bounds.
          if (currentRun.length > 0) {
            const lastPiece = currentRun[currentRun.length - 1];
            if (lastPiece) {
              lastPiece.text += "\n";
            }
          }
          continue;
        }
        const childStyle = getComputedStyle(childElement);
        const childPrincipalRect = childElement.getBoundingClientRect();
        const childRect =
          childStyle.display === "contents"
            ? displayContentsRenderedRect(childElement) ?? childPrincipalRect
            : childPrincipalRect;
        if (!isRenderable(childElement, childStyle, childRect)) {
          continue;
        }
        if (isInlineTextElement(childElement, childStyle)) {
          collectInline((childElement as HTMLElement).shadowRoot ?? childElement);
        } else {
          flushRun();
          const childNode = walkElement(childElement);
          if (childNode) {
            elementNode.children.push(childNode);
          }
        }
      }
    }

    const retainedVirtualChildren = virtualizedCapturedChildren.get(element);
    if (retainedVirtualChildren === undefined) {
      // Web components: an open shadow root replaces the light DOM as the
      // rendered (composed) tree; light children only appear through <slot>.
      const shadowRoot = (element as HTMLElement).shadowRoot;
      collectInline(shadowRoot ?? element);
      flushRun();
    } else {
      // The live virtual-list window is only the final viewport. Keep direct
      // text plus fixed/sticky children from that final state, then insert the
      // normal-flow item subtrees measured while each scroll band was live.
      processChildList(
        Array.from(element.childNodes).filter((child) => {
          if (child.nodeType !== Node.ELEMENT_NODE) return true;
          const position = getComputedStyle(child as Element).position;
          return position === "fixed" || position === "sticky";
        }),
      );
      flushRun();
      for (const child of retainedVirtualChildren) {
        elementNode.children.push(child);
        virtualizedInsertedNodes.push({ parent: elementNode, node: child });
      }
    }

    const afterNode = omittedThinMaskedPseudos.has("after")
      ? null
      : walkPseudoElement(element, rect, "after", style);
    if (afterNode) {
      elementNode.children.push(afterNode);
    }

    return elementNode;
  }

  /**
   * Extract a list ::marker (bullet or counter) as a synthetic node.
 *
   * A marker is a browser-generated box with no DOM node or rect API:
   * - Read glyph, color, and font size from getComputedStyle(el, "::marker").
   * - Derive box position from CSS rules. The outside marker's inline-end edge
   *   sits one UA gap before the li content box's inline-start edge and aligns
   *   with the first line box. Chromium kCMarkerPaddingPx is 7px. This is a UA
   *   layout constant, not an inference from content shape.
   * For list-style-image, use the computed ::marker size and actual asset URL
   * instead of guessing image marker dimensions from font or content shape.
   */
  function walkListMarker(
    element: Element,
    rect: DOMRect,
    style: CSSStyleDeclaration,
  ): CaptureNode | null {
    if (style.display !== "list-item") {
      return null;
    }
    const listType = style.listStyleType;
    if (!listType || listType === "none") {
      return null;
    }
    let ms: CSSStyleDeclaration;
    try {
      ms = window.getComputedStyle(element, "::marker");
    } catch {
      return null;
    }
    if (ms.content === "none" || ms.display === "none") {
      return null;
    }
    if (style.listStyleImage && style.listStyleImage !== "none") {
      const rawUrl = parseCssUrl(style.listStyleImage);
      const resolved = rawUrl === null ? null : resolveUrl(rawUrl);
      const markerWidth = parsePx(ms.width);
      const markerHeight = parsePx(ms.height);
      if (resolved === null || markerWidth <= 0 || markerHeight <= 0) {
        addWarning("marker_image_skipped", "list-style-image marker facts unavailable");
        return null;
      }
      if (nodeCount + 2 > maxNodes) {
        truncated = true;
        return null;
      }

      let assetId: string;
      let naturalSize: { naturalWidth?: number; naturalHeight?: number } = {};
      if (resolved.startsWith("data:")) {
        const commaIndex = resolved.indexOf(",");
        const mediaType =
          resolved.slice(5, commaIndex < 0 ? undefined : commaIndex).split(";")[0] ||
          "image/png";
        if (mediaType.toLowerCase() === "image/svg+xml") {
          naturalSize = parseSvgNaturalSize(resolved);
          const markup = decodeSvgDataUri(resolved);
          assetId = registerInlineAsset(
            markup === null ? "raster-image" : "svg-inline",
            markup ?? resolved,
            mediaType,
            naturalSize.naturalWidth,
            naturalSize.naturalHeight,
          );
        } else {
          assetId = registerInlineAsset("raster-image", resolved, mediaType);
        }
      } else {
        assetId = registerRemoteAsset(
          resolved,
          /\.svg([?#]|$)/i.test(resolved) ? "svg-image" : "raster-image",
        );
      }

      const contentLeft =
        rect.left + parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft);
      const contentTop =
        rect.top + parsePx(style.borderTopWidth) + parsePx(style.paddingTop);
      const outside = style.listStylePosition !== "inside";
      const MARKER_GAP_PX = 7;
      const bounds: PageRect = {
        x: (outside ? contentLeft - MARKER_GAP_PX - markerWidth : contentLeft) + scrollX,
        y: contentTop + scrollY,
        width: markerWidth,
        height: markerHeight,
      };
      nodeCount += 2;
      imageNodeCount += 1;
      return {
        id: nextNodeId(),
        type: "element",
        tag: "::marker",
        name: `${layerName(element)}::marker`,
        bounds,
        opacity: 1,
        clipsContent: false,
        fills: [],
        children: [
          {
            id: nextNodeId(),
            type: "image",
            tag: "::marker-image",
            name: `${layerName(element)}::marker-image`,
            bounds,
            opacity: 1,
            clipsContent: false,
            assetId,
            scaleMode: "fit",
            ...naturalSize,
          },
        ],
        pseudo: "marker",
      };
    }
    // Map symbolic glyphs directly; generate counters from the sibling li index.
    const SYMBOL_GLYPHS: Record<string, string> = {
      disc: "•",
      circle: "◦",
      square: "▪",
    };
    let glyph = SYMBOL_GLYPHS[listType];
    if (glyph === undefined) {
      if (listType !== "decimal") {
        // Other counter systems (lower-alpha, lower-roman, locale-specific
        // counters, and so on) are not implemented. Warn explicitly instead of
        // silently losing fidelity.
        addWarning("marker_type_skipped", listType);
        return null;
      }
      let ordinal = 1;
      const parent = element.parentElement;
      if (parent) {
        const startAttr = Number.parseInt(parent.getAttribute("start") ?? "", 10);
        if (Number.isFinite(startAttr)) {
          ordinal = startAttr;
        }
        for (let sib = element.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.tagName === element.tagName) {
            ordinal += 1;
          }
        }
      }
      glyph = `${ordinal}.`;
    }
    if (nodeCount + 2 > maxNodes) {
      truncated = true;
      return null;
    }
    const textStyle = extractTextStyle(ms);
    const markerColor = parseColor(ms.color);
    if (markerColor) {
      textStyle.color = markerColor;
    }
    // Measure glyph width with canvas measureText using the ::marker font.
    const glyphWidth = measureGlyphWidth(glyph, ms);
    const contentLeft =
      rect.left + parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft);
    const contentTop =
      rect.top + parsePx(style.borderTopWidth) + parsePx(style.paddingTop);
    const outside = style.listStylePosition !== "inside";
    const MARKER_GAP_PX = 7; // Chromium kCMarkerPaddingPx
    const x = outside ? contentLeft - MARKER_GAP_PX - glyphWidth : contentLeft;
    const bounds: PageRect = {
      x: x + scrollX,
      y: contentTop + scrollY,
      width: Math.max(1, glyphWidth),
      height: textStyle.lineHeightPx,
    };
    nodeCount += 2;
    textNodeCount += 1;
    const markerNode: CaptureElementNode = {
      id: nextNodeId(),
      type: "element",
      tag: "::marker",
      name: `${layerName(element)}::marker`,
      bounds,
      opacity: 1,
      clipsContent: false,
      fills: [],
      children: [
        {
          id: nextNodeId(),
          type: "text",
          tag: "#text",
          name: glyph,
          bounds,
          opacity: 1,
          clipsContent: false,
          text: glyph,
          segments: [{ text: glyph, style: textStyle }],
          style: textStyle,
        },
      ],
      pseudo: "marker",
    };
    return markerNode;
  }

  let glyphMeasureContext: CanvasRenderingContext2D | null = null;
  /** Measure glyph width with canvas measureText using the same font and size. */
  function measureGlyphWidth(glyph: string, ms: CSSStyleDeclaration): number {
    try {
      if (!glyphMeasureContext) {
        glyphMeasureContext = document.createElement("canvas").getContext("2d");
      }
      if (glyphMeasureContext) {
        glyphMeasureContext.font = canvasFontFromComputedStyle(ms);
        const w = glyphMeasureContext.measureText(glyph).width;
        if (Number.isFinite(w) && w > 0) {
          return w;
        }
      }
    } catch {
      // fall through to font-size approximation
    }
    return parsePx(ms.fontSize) * 0.5;
  }

  const pseudoGlyphAssetIds = new Map<string, string>();

  function normalizedFontFamily(value: string): string {
    const trimmed = value.trim();
    if (
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ) {
      return trimmed.slice(1, -1).trim().toLocaleLowerCase();
    }
    return trimmed.toLocaleLowerCase();
  }

  /**
   * Browser fact: the pseudo's first-choice family is backed by a loaded
   * FontFace. Generated content is not editable DOM text, and Figma cannot
   * load arbitrary site font files, so preserve these glyph pixels at source.
   */
  function firstFontFamily(ms: CSSStyleDeclaration): string | null {
    const firstFamily = splitTopLevel(ms.fontFamily, ",")[0];
    if (!firstFamily) return null;
    const normalized = normalizedFontFamily(firstFamily);
    return normalized || null;
  }

  function hasRenderedDomText(element: Element): boolean {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      if (!hasNonCollapsibleContent(text)) continue;
      const parent = node.parentElement;
      if (parent === null) continue;
      const style = getComputedStyle(parent);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }
    return false;
  }

  function usesLoadedAuthoredFont(
    ms: CSSStyleDeclaration,
    parentStyle?: CSSStyleDeclaration,
    hostElement?: Element,
  ): boolean {
    const wanted = firstFontFamily(ms);
    if (!wanted) return false;
    // Inherited site typography remains editable text. Icon fonts normally
    // override the host family; that computed-style difference is a browser
    // fact and avoids rasterizing ordinary ::before/::after labels.
    if (
      parentStyle !== undefined &&
      firstFontFamily(parentStyle) === wanted &&
      (hostElement === undefined || hasRenderedDomText(hostElement))
    ) {
      return false;
    }
    let loaded = false;
    try {
      document.fonts.forEach((fontFace) => {
        if (
          fontFace.status === "loaded" &&
          normalizedFontFamily(fontFace.family) === wanted
        ) {
          loaded = true;
        }
      });
    } catch {
      return false;
    }
    return loaded;
  }

  function rasterizePseudoGlyph(
    contentText: string,
    ms: CSSStyleDeclaration,
    bounds: PageRect,
    parentStyle?: CSSStyleDeclaration,
    hostElement?: Element,
  ): { assetId: string; naturalWidth: number; naturalHeight: number } | null {
    const firstFamily = firstFontFamily(ms);
    const usesPrivateUseIconFont =
      firstFamily !== null &&
      Array.from(contentText).some(
        (character) =>
          isPrivateUseCodePoint(character) &&
          !browserRenderedGlyphUsesFallbackFont(character, ms, firstFamily),
      );
    if (!usesPrivateUseIconFont && !usesLoadedAuthoredFont(ms, parentStyle, hostElement)) {
      return null;
    }
    const cssWidth = Math.max(1, bounds.width);
    const cssHeight = Math.max(1, bounds.height);
    const pixelScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.ceil(cssWidth * pixelScale));
    const pixelHeight = Math.max(1, Math.ceil(cssHeight * pixelScale));
    const font = canvasFontFromComputedStyle(ms);
    const key = JSON.stringify([
      contentText,
      font,
      ms.color,
      ms.textAlign,
      ms.direction,
      ms.letterSpacing,
      pixelWidth,
      pixelHeight,
    ]);
    const existing = pseudoGlyphAssetIds.get(key);
    if (existing !== undefined) {
      return { assetId: existing, naturalWidth: pixelWidth, naturalHeight: pixelHeight };
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.scale(pixelScale, pixelScale);
      context.font = font;
      context.fillStyle = ms.color;
      context.direction = ms.direction === "rtl" ? "rtl" : "ltr";
      const advancedContext = context as CanvasRenderingContext2D & {
        letterSpacing?: string;
      };
      if ("letterSpacing" in advancedContext) {
        advancedContext.letterSpacing = ms.letterSpacing;
      }
      const align = ms.textAlign;
      if (align === "center") {
        context.textAlign = "center";
      } else if (align === "right" || align === "end") {
        context.textAlign = "right";
      } else {
        context.textAlign = "left";
      }
      const preferredX =
        context.textAlign === "center"
          ? cssWidth / 2
          : context.textAlign === "right"
            ? cssWidth
            : 0;
      const metrics = context.measureText(contentText);
      const minimumX = metrics.actualBoundingBoxLeft;
      const maximumX = cssWidth - metrics.actualBoundingBoxRight;
      const x =
        minimumX <= maximumX
          ? Math.min(maximumX, Math.max(minimumX, preferredX))
          : preferredX;
      const ascent = metrics.actualBoundingBoxAscent || parsePx(ms.fontSize) * 0.8;
      const descent = metrics.actualBoundingBoxDescent || parsePx(ms.fontSize) * 0.2;
      const baseline = Math.max(ascent, (cssHeight - ascent - descent) / 2 + ascent);
      context.textBaseline = "alphabetic";
      context.fillText(contentText, x, baseline);
      const assetId = registerInlineAsset(
        "raster-image",
        canvas.toDataURL("image/png"),
        "image/png",
        pixelWidth,
        pixelHeight,
      );
      pseudoGlyphAssetIds.set(key, assetId);
      return { assetId, naturalWidth: pixelWidth, naturalHeight: pixelHeight };
    } catch {
      return null;
    }
  }

  /**
   * Extract CSS pseudo-elements (::before/::after) as synthetic nodes.
 *
   * Pseudo-elements do not expose getBoundingClientRect, so derive bounds from
   * pixel-valued computed style facts:
   * - Resolve absolute/fixed positioning from inset/width/height against the
   *   parent box.
   * - Resolve a bottom-sticky block ::after in a scroll container from its
   *   bottom inset only when direct normal-flow content is unambiguously
   *   determined by static block boxes.
   * - In other cases, emit only when width and height are definite pixel values.
   * If no definite size can be resolved and there is no text, skip the node,
   * record a warning, and never guess.
   */
  function parseGeneratedContentText(value: string): {
    text: string;
    complete: boolean;
  } {
    let index = 0;
    let result = "";
    while (index < value.length) {
      while (/\s/.test(value[index] ?? "")) index += 1;
      if (value[index] === "/") {
        return { text: result, complete: true };
      }
      const quote = value[index];
      if (quote !== '"' && quote !== "'") {
        return { text: result, complete: false };
      }
      index += 1;
      let raw = "";
      let closed = false;
      while (index < value.length) {
        const char = value[index]!;
        if (char === "\\") {
          raw += char;
          index += 1;
          if (index < value.length) {
            raw += value[index]!;
            index += 1;
          }
          continue;
        }
        if (char === quote) {
          index += 1;
          closed = true;
          break;
        }
        raw += char;
        index += 1;
      }
      if (!closed) return { text: "", complete: false };
      result += unescapeCssValue(raw);
    }
    return { text: result, complete: true };
  }

  function pseudoBorderBoxSize(style: CSSStyleDeclaration): {
    width: number;
    height: number;
  } {
    const contentWidth = parsePx(style.width);
    const contentHeight = parsePx(style.height);
    const horizontalExtras =
      parsePx(style.paddingLeft) +
      parsePx(style.paddingRight) +
      parsePx(style.borderLeftWidth) +
      parsePx(style.borderRightWidth);
    const verticalExtras =
      parsePx(style.paddingTop) +
      parsePx(style.paddingBottom) +
      parsePx(style.borderTopWidth) +
      parsePx(style.borderBottomWidth);
    return {
      width:
        style.boxSizing === "border-box"
          ? contentWidth
          : Math.max(0, contentWidth + horizontalExtras),
      height:
        style.boxSizing === "border-box"
          ? contentHeight
          : Math.max(0, contentHeight + verticalExtras),
    };
  }

  /**
   * Resolve the auto-placed row of an in-flow grid ::after from Chromium's
   * used track sizes. Child paint bounds are not track bounds: an align-self
   * start item can be 60px tall inside a 200px authored row. Restrict this to
   * the unambiguous one-column, auto-placement case and otherwise keep the
   * conservative fallback.
   */
  function gridAfterFlowTop(
    element: Element,
    parentRect: DOMRect,
    parentStyle: CSSStyleDeclaration | undefined,
    pseudoStyle: CSSStyleDeclaration,
  ): number | null {
    if (
      parentStyle === undefined ||
      (parentStyle.display !== "grid" && parentStyle.display !== "inline-grid") ||
      pseudoStyle.position === "absolute" ||
      pseudoStyle.position === "fixed" ||
      pseudoStyle.gridRowStart !== "auto" ||
      pseudoStyle.gridRowEnd !== "auto" ||
      pseudoStyle.gridColumnStart !== "auto" ||
      pseudoStyle.gridColumnEnd !== "auto" ||
      parentStyle.gridAutoFlow.includes("column")
    ) {
      return null;
    }

    const allowedAlignContent = new Set(["normal", "stretch", "start", "flex-start"]);
    if (!allowedAlignContent.has(parentStyle.alignContent)) {
      return null;
    }

    const parseUsedTracks = (value: string): number[] | null => {
      const tokens = splitTopLevel(value.trim(), " ");
      if (tokens.length === 0) return null;
      const tracks: number[] = [];
      for (const token of tokens) {
        const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(token);
        if (match === null) return null;
        const size = Number(match[1]);
        if (!Number.isFinite(size) || size < 0) return null;
        tracks.push(size);
      }
      return tracks;
    };
    const columns = parseUsedTracks(parentStyle.gridTemplateColumns);
    if (columns === null || columns.length !== 1) return null;

    // Anonymous text grid items have no direct Element geometry. Do not
    // invent a row for those cases; the existing conservative path keeps the
    // pseudo rather than moving it based on content shape.
    for (const childNode of Array.from(element.childNodes)) {
      if (
        childNode.nodeType === Node.TEXT_NODE &&
        /[^\t\n\f\r ]/.test(childNode.textContent ?? "")
      ) {
        return null;
      }
    }

    const flowChildren = Array.from(element.children).filter((child) => {
      const style = getComputedStyle(child);
      if (style.display === "none" || style.position === "absolute" || style.position === "fixed") {
        return false;
      }
      return true;
    });
    if (flowChildren.length === 0) {
      return null;
    }
    for (const child of flowChildren) {
      const childStyle = getComputedStyle(child);
      if (
        childStyle.display === "contents" ||
        childStyle.gridRowStart !== "auto" ||
        childStyle.gridRowEnd !== "auto" ||
        childStyle.gridColumnStart !== "auto" ||
        childStyle.gridColumnEnd !== "auto"
      ) {
        return null;
      }
    }

    const rows = parseUsedTracks(parentStyle.gridTemplateRows);
    if (rows === null || rows.length < flowChildren.length) return null;
    const contentTop =
      parentRect.top +
      parsePx(parentStyle.borderTopWidth) +
      parsePx(parentStyle.paddingTop);
    const precedingTrackHeight = rows
      .slice(0, flowChildren.length)
      .reduce((sum, size) => sum + size, 0);
    return (
      contentTop +
      precedingTrackHeight +
      parsePx(parentStyle.rowGap) * flowChildren.length +
      parsePx(pseudoStyle.marginTop)
    );
  }

  function walkPseudoElement(
    element: Element,
    parentRect: DOMRect,
    which: "before" | "after",
    parentStyle?: CSSStyleDeclaration,
  ): CaptureNode | null {
    let ps: CSSStyleDeclaration;
    try {
      ps = window.getComputedStyle(element, `::${which}`);
    } catch {
      return null;
    }
    const content = ps.content;
    if (!content || content === "none" || content === "normal") {
      return null;
    }
    if (ps.display === "none" || ps.visibility === "hidden") {
      return null;
    }
    const pseudoOpacity = Number.parseFloat(ps.opacity);
    if (pseudoOpacity === 0) {
      return null;
    }
    // Computed content may include CSS alt text (`"glyph" / "label"`). Only
    // the generated string before `/` is painted; the alternate is exposed
    // to accessibility APIs and must never become visible glyph pixels.
    const contentText = parseGeneratedContentText(content).text;
    // Browser fact: inline elements expose one client rect per rendered line.
    // Those fragments include generated content, so the first/last fragment
    // gives the actual line that owns ::before/::after even when the host wraps.
    // The union rect cannot provide that position (its right edge may belong to
    // an earlier line).
    const inlineFragment = (() => {
      if (parentStyle?.display !== "inline") return null;
      const fragments = Array.from(element.getClientRects()).filter(
        (fragment) => fragment.width > 0 && fragment.height > 0,
      );
      return which === "before" ? (fragments[0] ?? null) : (fragments.at(-1) ?? null);
    })();

    const pseudoBox = pseudoBorderBoxSize(ps);
    const w = pseudoBox.width;
    const h = pseudoBox.height;
    let bounds: PageRect | null = null;
    const parentClipsY =
      parentStyle !== undefined &&
      ["auto", "scroll", "hidden"].includes(parentStyle.overflowY);
    const isBottomPinnedCandidate =
      ps.position === "sticky" &&
      which === "after" &&
      ps.display === "block" &&
      ps.bottom !== "auto" &&
      ps.top === "auto" &&
      w > 0 &&
      h > 0 &&
      parentClipsY &&
      parentStyle !== undefined &&
      (parentStyle.display === "block" || parentStyle.display === "flow-root") &&
      parentStyle.writingMode === "horizontal-tb";
    let bottomPinnedStaticY: number | null = null;
    if (isBottomPinnedCandidate && parentStyle !== undefined) {
      const borderTop = parsePx(parentStyle.borderTopWidth);
      const paddingTop = parsePx(parentStyle.paddingTop);
      let staticY = parentRect.top + borderTop + paddingTop;
      let isSimpleBlockFlow = true;
      const blockDisplays = ["block", "flow-root", "list-item", "table", "flex", "grid"];
      const preservesSpaces = ["pre", "pre-wrap", "break-spaces"].includes(
        parentStyle.whiteSpace,
      );
      const preservesLineBreaks = preservesSpaces || parentStyle.whiteSpace === "pre-line";
      const beforeStyle = getComputedStyle(element, "::before");
      if (
        beforeStyle.content &&
        beforeStyle.content !== "none" &&
        beforeStyle.content !== "normal" &&
        beforeStyle.display !== "none" &&
        beforeStyle.position !== "absolute" &&
        beforeStyle.position !== "fixed"
      ) {
        isSimpleBlockFlow = false;
      }
      for (
        let index = 0;
        isSimpleBlockFlow && index < element.childNodes.length;
        index += 1
      ) {
        const childNode = element.childNodes[index];
        if (!childNode) continue;
        if (childNode.nodeType === 3) {
          const text = childNode.textContent ?? "";
          if (
            /[^\t\n\f\r ]/.test(text) ||
            (preservesSpaces && text.length > 0) ||
            (preservesLineBreaks && /[\n\f\r]/.test(text))
          ) {
            isSimpleBlockFlow = false;
            break;
          }
          continue;
        }
        if (!(childNode instanceof Element)) continue;
        const childStyle = getComputedStyle(childNode);
        if (childStyle.display === "none") continue;
        if (childStyle.position === "absolute" || childStyle.position === "fixed") continue;
        const margins = [
          childStyle.marginTop,
          childStyle.marginRight,
          childStyle.marginBottom,
          childStyle.marginLeft,
        ];
        let hasGeneratedPseudo = false;
        for (const pseudo of ["before", "after"] as const) {
          const childPseudoStyle = getComputedStyle(childNode, `::${pseudo}`);
          if (
            childPseudoStyle.content &&
            childPseudoStyle.content !== "none" &&
            childPseudoStyle.content !== "normal" &&
            childPseudoStyle.display !== "none"
          ) {
            hasGeneratedPseudo = true;
            break;
          }
        }
        if (
          childStyle.position !== "static" ||
          childStyle.transform !== "none" ||
          childStyle.cssFloat !== "none" ||
          !blockDisplays.includes(childStyle.display) ||
          childNode.childElementCount > 0 ||
          hasGeneratedPseudo ||
          margins.some((margin) => {
            const value = Number.parseFloat(margin);
            return !Number.isFinite(value) || Math.abs(value) > 0.0001;
          })
        ) {
          isSimpleBlockFlow = false;
          break;
        }
        staticY = Math.max(staticY, childNode.getBoundingClientRect().bottom);
      }
      if (isSimpleBlockFlow) {
        bottomPinnedStaticY = staticY;
      } else {
        addWarning(
          "pseudo_unmeasurable",
          "::after bottom-sticky flow cannot be measured without DOM mutation",
        );
        return null;
      }
    }
    const isBottomPinnedScrollAfter = bottomPinnedStaticY !== null;
    if (ps.position === "absolute" || ps.position === "fixed" || isBottomPinnedScrollAfter) {
      const left = parsePx(ps.left);
      const right = parsePx(ps.right);
      const top = parsePx(ps.top);
      const bottom = parsePx(ps.bottom);
      const leftAuto = ps.left === "auto";
      const rightAuto = ps.right === "auto";
      const topAuto = ps.top === "auto";
      const bottomAuto = ps.bottom === "auto";
      // Prefer a pixel width; otherwise stretch between left and right.
      const resolvedW =
        w > 0 ? w : !leftAuto && !rightAuto ? Math.max(0, parentRect.width - left - right) : 0;
      const resolvedH =
        h > 0 ? h : !topAuto && !bottomAuto ? Math.max(0, parentRect.height - top - bottom) : 0;
      if (resolvedW > 0 && resolvedH > 0) {
        const x = !leftAuto
          ? parentRect.left + left
          : !rightAuto
            ? parentRect.right - right - resolvedW
            : parentRect.left;
        let y: number;
        if (isBottomPinnedScrollAfter && bottomPinnedStaticY !== null) {
          y = Math.min(bottomPinnedStaticY!, parentRect.bottom - bottom - resolvedH);
        } else {
          y = !topAuto
            ? parentRect.top + top
            : !bottomAuto
              ? parentRect.bottom - bottom - resolvedH
              : parentRect.top;
        }
        bounds = { x: x + scrollX, y: y + scrollY, width: resolvedW, height: resolvedH };
      }
    } else if (w > 0 && h > 0) {
      // For in-flow pseudo-elements, derive the main-axis position from CSS
      // layout rules rather than attaching it to the border-box edge.
      // ::before/::after participate in the parent's content-box layout, so
      // subtract border and padding first.
      const padLeft = parentStyle !== undefined ? parsePx(parentStyle.paddingLeft) : 0;
      const padRight = parentStyle !== undefined ? parsePx(parentStyle.paddingRight) : 0;
      const borderLeft = parentStyle !== undefined ? parsePx(parentStyle.borderLeftWidth) : 0;
      const borderRight = parentStyle !== undefined ? parsePx(parentStyle.borderRightWidth) : 0;
      const contentLeft = parentRect.left + borderLeft + padLeft;
      const contentRight = parentRect.right - borderRight - padRight;
      const isRtl = parentStyle?.direction === "rtl";
      const isRowFlex =
        parentStyle !== undefined &&
        (parentStyle.display === "flex" || parentStyle.display === "inline-flex") &&
        !parentStyle.flexDirection.startsWith("column");
      let x =
        inlineFragment !== null
          ? which === "before"
            ? inlineFragment.left
            : inlineFragment.right - w
          : which === "before"
            ? isRtl
              ? contentRight - w
              : contentLeft
            : isRtl
              ? contentLeft
              : contentRight - w;
      if (which === "before" && inlineFragment === null) {
        // Margins reserve inline flow space; relative offsets move only the
        // painted generated box. Keep both browser-computed facts explicit.
        const relativeX =
          ps.position === "relative" && ps.left !== "auto" ? parsePx(ps.left) : 0;
        x = isRtl
          ? contentRight - parsePx(ps.marginRight) - w + relativeX
          : contentLeft + parsePx(ps.marginLeft) + relativeX;
      }
      if (which === "after" && isRowFlex) {
        // In a row flex container, ::after is the final flex item. With
        // start-aligned stacking (justify-content: normal/flex-start), place it
        // after the final in-flow child plus column-gap. Child rects are direct
        // layout facts. For other justify-content values such as flex-end or
        // space-between, keep the default at the content-box end edge.
        const jc = parentStyle.justifyContent;
        if (jc === "normal" || jc === "flex-start" || jc === "start" || jc === "left") {
          let lastRight = contentLeft;
          for (let i = 0; i < element.children.length; i++) {
            const child = element.children[i];
            if (!child) continue;
            const r = child.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) lastRight = Math.max(lastRight, r.right);
          }
          const colGap = parsePx(parentStyle.columnGap);
          x = lastRight + (Number.isFinite(colGap) ? colGap : 0);
        }
      }
      // In a row flex parent, the pseudo-element is a real flex item whose
      // cross-axis position follows align-items/align-self. This is a CSS layout
      // derivation, not a content guess. Always attaching it to parentRect.top
      // made centered icons such as an MDN header chevron stick to the top of a
      // tall button.
      const contentTop =
        parentRect.top +
        (parentStyle !== undefined ? parsePx(parentStyle.borderTopWidth) : 0) +
        (parentStyle !== undefined ? parsePx(parentStyle.paddingTop) : 0);
      let y = inlineFragment?.top ?? contentTop;
      if (which === "after") {
        const gridTop = gridAfterFlowTop(element, parentRect, parentStyle, ps);
        if (gridTop !== null) {
          y = gridTop;
        }
      }
      if (
        inlineFragment === null &&
        ps.verticalAlign === "middle" &&
        parentStyle !== undefined
      ) {
        y = contentTop + Math.max(0, (parsePx(parentStyle.lineHeight) - h) / 2);
      }
      if (ps.position === "relative" && ps.top !== "auto") {
        y += parsePx(ps.top);
      }
      if (
        parentStyle !== undefined &&
        (parentStyle.display === "flex" || parentStyle.display === "inline-flex") &&
        !parentStyle.flexDirection.startsWith("column")
      ) {
        const selfAlign = ps.alignSelf !== "auto" ? ps.alignSelf : parentStyle.alignItems;
        if (selfAlign === "center") {
          y = parentRect.top + (parentRect.height - h) / 2;
        } else if (selfAlign === "flex-end" || selfAlign === "end") {
          y = parentRect.bottom - h;
        }
      }
      bounds = { x: x + scrollX, y: y + scrollY, width: w, height: h };
    }

    if (bounds !== null) {
      const transformedBounds = applyStructurallyRepresentablePseudoTransform(bounds, ps);
      if (transformedBounds === null) {
        return null;
      }
      if (transformedBounds === undefined) {
        addWarning(
          "unsupported_transform",
          `::${which} transform changed during extraction`,
        );
        return null;
      }
      bounds = transformedBounds;
    }

    const fills = extractFills(ps, bounds?.width ?? parentRect.width, bounds?.height ?? parentRect.height);
    const borders = extractBorders(ps);
    const hasPaint = fills.length > 0 || borders !== undefined;
    if (!bounds) {
      if (!contentText) {
        if (hasPaint) {
          addWarning("pseudo_unmeasurable", `::${which} with paint but no resolvable size`);
        }
        return null;
      }
      // For a text-only pseudo-element such as content: "→", measure glyph width
      // in browser canvas with the same font.
      const textStyle = extractTextStyle(ps);
      const approxW = Math.min(parentRect.width, measureGlyphWidth(contentText, ps));
      const x =
        inlineFragment !== null
          ? which === "before"
            ? inlineFragment.left
            : inlineFragment.right - approxW
          : which === "before"
            ? parentRect.left
            : parentRect.right - approxW;
      bounds = {
        x: x + scrollX,
        y: (inlineFragment?.top ?? parentRect.top) + scrollY,
        width: Math.max(1, approxW),
        height: textStyle.lineHeightPx,
      };
    }
    if (!hasPaint && !contentText) {
      return null;
    }
    if (nodeCount >= maxNodes) {
      truncated = true;
      return null;
    }

    nodeCount += 1;
    const cornerRadii = extractCornerRadii(ps, bounds.width, bounds.height);
    const shadows = extractShadows(ps);
    const pseudoNode: CaptureElementNode = {
      id: nextNodeId(),
      type: "element",
      tag: `::${which}`,
      name: `${layerName(element)}::${which}`,
      bounds,
      opacity: Number.isFinite(pseudoOpacity) ? pseudoOpacity : 1,
      clipsContent: false,
      fills,
      ...(borders !== undefined ? { borders } : {}),
      ...(cornerRadii !== undefined ? { cornerRadii } : {}),
      ...(shadows !== undefined ? { shadows } : {}),
      // Pseudo stacking facts (z-index:-1 absolute backgrounds) must reach
      // conversion paint-order sorting; without them a full-bleed ::after
      // paints over nav text/icons (Bootstrap sticky header).
      ...extractStackingFacts(ps, element),
      children: [],
      pseudo: which,
    };
    // Pseudo blend modes are browser facts too (CSS-Tricks article thumbs use
    // ::after { mix-blend-mode: screen } over an opaque gradient). Without this
    // field conversion paints the gradient as a solid cover.
    if (ps.mixBlendMode && ps.mixBlendMode !== "normal") {
      pseudoNode.mixBlendMode = ps.mixBlendMode;
    }
    const pseudoRotation = extractRotation(ps);
    if (pseudoRotation !== undefined) {
      pseudoNode.rotationDegrees = pseudoRotation;
    }
    if (contentText) {
      const rasterGlyph = rasterizePseudoGlyph(
        contentText,
        ps,
        bounds,
        parentStyle,
        element,
      );
      nodeCount += 1;
      if (rasterGlyph !== null) {
        imageNodeCount += 1;
        pseudoNode.children.push({
          id: nextNodeId(),
          type: "image",
          tag: "#generated-content",
          name: contentText.length > 24 ? `${contentText.slice(0, 24)}…` : contentText,
          bounds,
          opacity: 1,
          clipsContent: false,
          scaleMode: "fill",
          assetId: rasterGlyph.assetId,
          naturalWidth: rasterGlyph.naturalWidth,
          naturalHeight: rasterGlyph.naturalHeight,
        });
      } else {
        const textStyle = extractTextStyle(ps);
        textNodeCount += 1;
        pseudoNode.children.push({
          id: nextNodeId(),
          type: "text",
          tag: "#text",
          name: contentText.length > 24 ? `${contentText.slice(0, 24)}…` : contentText,
          bounds,
          opacity: 1,
          clipsContent: false,
          text: contentText,
          segments: [{ text: contentText, style: textStyle }],
          style: textStyle,
        });
      }
    }
    return pseudoNode;
  }

  interface VirtualCandidateState {
    container: Element;
    evictedChildren: Set<Element>;
    reusedChildren: Set<Element>;
    observedBands: Set<number>;
    seenChildren: Set<Element>;
    lastPageYByChild: Map<Element, number>;
  }

  function virtualScrollDelay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  function frozenAnimationFrameBaseline(): Set<number> | null {
    const globals = window as unknown as Record<string, unknown>;
    const pending = globals.__h2fRafPending;
    if (globals.__h2fRafFrozen !== true || !(pending instanceof Map)) return null;
    return new Set(pending.keys() as Iterable<number>);
  }

  async function flushScrollScheduledAnimationFrames(
    baseline: Set<number> | null,
  ): Promise<void> {
    if (baseline === null) return;
    const globals = window as unknown as Record<string, unknown>;
    for (let round = 0; round < 2; round += 1) {
      const pending = globals.__h2fRafPending;
      if (!(pending instanceof Map)) return;
      const callbacks = Array.from(
        pending.entries() as Iterable<[number, FrameRequestCallback]>,
      ).filter(([handle]) => !baseline.has(handle));
      if (callbacks.length === 0) return;
      const timestamp = performance.now();
      for (const [handle, callback] of callbacks) {
        pending.delete(handle);
        try {
          callback(timestamp);
        } catch {
          // A page callback must not abort capture; the next measured state
          // decides whether this container can be retained safely.
        }
      }
      await virtualScrollDelay(0);
    }
  }

  function scrollWindowTo(top: number): void {
    try {
      window.scrollTo({ top, left: initialScrollX, behavior: "instant" as ScrollBehavior });
    } catch {
      window.scrollTo(initialScrollX, top);
    }
  }

  function updateMeasuredScroll(): void {
    scrollX = window.scrollX;
    scrollY = window.scrollY;
  }

  function viewportIntersects(rect: DOMRect): boolean {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  }

  function visibleVirtualChildren(container: Element): Element[] {
    const visible: Element[] = [];
    for (let index = 0; index < container.children.length; index += 1) {
      const child = container.children.item(index);
      if (child === null) continue;
      const style = getComputedStyle(child);
      if (style.position === "fixed" || style.position === "sticky") continue;
      const rect = child.getBoundingClientRect();
      if (viewportIntersects(rect)) visible.push(child);
    }
    return visible;
  }

  function isSparseTallVirtualCandidate(candidate: Element): boolean {
    if (candidate === document.body || candidate === document.documentElement) return false;
    const style = getComputedStyle(candidate);
    if (style.position === "fixed" || style.position === "sticky") return false;
    const rect = candidate.getBoundingClientRect();
    const viewportHeight = Math.max(1, window.innerHeight);
    if (
      rect.width < 80 ||
      rect.height < viewportHeight * 3 ||
      !viewportIntersects(rect) ||
      candidate.children.length < 2
    ) {
      return false;
    }
    let renderedChildCount = 0;
    let maximumChildBottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < candidate.children.length; index += 1) {
      const child = candidate.children.item(index);
      if (child === null) continue;
      const childRect = child.getBoundingClientRect();
      if (childRect.width <= 0 || childRect.height <= 0) continue;
      renderedChildCount += 1;
      maximumChildBottom = Math.max(maximumChildBottom, childRect.bottom + window.scrollY);
    }
    if (renderedChildCount < 2 || !Number.isFinite(maximumChildBottom)) return false;
    const candidateBottom = rect.bottom + window.scrollY;
    return candidateBottom - maximumChildBottom >= Math.max(viewportHeight * 2, 800);
  }

  function sparseTallCandidatesAtCurrentViewport(): Element[] {
    const candidates = new Set<Element>();
    const xFractions = [0.15, 0.35, 0.5, 0.65, 0.85];
    const yFractions = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const xFraction of xFractions) {
      for (const yFraction of yFractions) {
        const x = Math.min(window.innerWidth - 1, Math.max(0, window.innerWidth * xFraction));
        const y = Math.min(window.innerHeight - 1, Math.max(0, window.innerHeight * yFraction));
        for (const hit of document.elementsFromPoint(x, y)) {
          for (
            let current: Element | null = hit;
            current !== null && current !== document.body && current !== document.documentElement;
            current = current.parentElement
          ) {
            if (isSparseTallVirtualCandidate(current)) candidates.add(current);
          }
        }
      }
    }
    const ordered = Array.from(candidates).sort(
      (left, right) =>
        left.getBoundingClientRect().height - right.getBoundingClientRect().height,
    );
    return ordered
      .filter(
        (candidate) =>
          !ordered.some(
            (other) => other !== candidate && candidate.contains(other),
          ),
      )
      .slice(0, 4);
  }

  async function scanVirtualDocument(
    onPosition: () => void,
    maximumScroll: number,
  ): Promise<{ reachedBoundary: boolean; steps: number }> {
    const viewportHeight = Math.max(1, window.innerHeight);
    const step = Math.max(200, Math.floor(viewportHeight * 0.75));
    let stagnantSteps = 0;
    let steps = 0;
    while (steps < 200) {
      updateMeasuredScroll();
      onPosition();
      if (window.scrollY >= maximumScroll - 2) {
        break;
      }
      const before = window.scrollY;
      const frozenFrameBaseline = frozenAnimationFrameBaseline();
      scrollWindowTo(Math.min(maximumScroll, before + step));
      steps += 1;
      await virtualScrollDelay(90);
      await flushScrollScheduledAnimationFrames(frozenFrameBaseline);
      const after = window.scrollY;
      stagnantSteps = after <= before + 1 ? stagnantSteps + 1 : 0;
      if (stagnantSteps >= 2) break;
    }
    updateMeasuredScroll();
    onPosition();
    return { reachedBoundary: window.scrollY >= maximumScroll - 2, steps };
  }

  async function restoreVirtualScanOrigin(): Promise<void> {
    const frozenFrameBaseline = frozenAnimationFrameBaseline();
    scrollWindowTo(initialScrollY);
    await virtualScrollDelay(180);
    await flushScrollScheduledAnimationFrames(frozenFrameBaseline);
    updateMeasuredScroll();
  }

  async function retainVirtualizedDocumentChildren(): Promise<{
    incomplete: boolean;
    truncated: boolean;
  }> {
    if (
      options.captureVirtualizedContent !== true ||
      options.viewportClip !== undefined
    ) {
      return { incomplete: false, truncated: false };
    }
    const candidates = sparseTallCandidatesAtCurrentViewport();
    if (candidates.length === 0) return { incomplete: false, truncated: false };
    // Freeze one observation frontier for both passes. Infinite feeds may
    // append another page when the probe first reaches this boundary; that
    // growth is deliberately excluded from the current capture rather than
    // becoming a new target for either pass.
    const scanMaximumScroll = Math.max(
      initialScrollY,
      capturePageHeight - Math.max(1, window.innerHeight),
    );

    const states = candidates.map<VirtualCandidateState>((container) => ({
      container,
      evictedChildren: new Set<Element>(),
      reusedChildren: new Set<Element>(),
      observedBands: new Set<number>(),
      seenChildren: new Set<Element>(),
      lastPageYByChild: new Map<Element, number>(),
    }));
    await scanVirtualDocument(() => {
      const band = Math.floor(window.scrollY / Math.max(1, window.innerHeight));
      for (const state of states) {
        if (!state.container.isConnected) continue;
        for (const child of state.seenChildren) {
          if (!child.isConnected || child.parentElement !== state.container) {
            state.evictedChildren.add(child);
          }
        }
        const visible = visibleVirtualChildren(state.container);
        if (visible.length > 0) state.observedBands.add(band);
        for (const child of visible) {
          const pageY = child.getBoundingClientRect().top + window.scrollY;
          const previousPageY = state.lastPageYByChild.get(child);
          if (
            previousPageY !== undefined &&
            Math.abs(pageY - previousPageY) >= Math.max(100, window.innerHeight * 0.5)
          ) {
            state.reusedChildren.add(child);
          }
          state.lastPageYByChild.set(child, pageY);
          state.seenChildren.add(child);
        }
      }
    }, scanMaximumScroll);
    await restoreVirtualScanOrigin();

    const detected = states
      .filter(
        (state) =>
          state.container.isConnected &&
          (state.evictedChildren.size >= 2 || state.reusedChildren.size >= 2) &&
          state.observedBands.size >= 2 &&
          state.seenChildren.size >= 5,
      )
      .map((state) => state.container)
      .filter(
        (candidate, _index, all) =>
          !all.some((other) => other !== candidate && candidate.contains(other)),
      );
    if (detected.length === 0) return { incomplete: false, truncated: false };

    const snapshots = new Map<Element, Map<string, CaptureNode>>();
    let captureBudgetReached = false;
    const captureScan = await scanVirtualDocument(() => {
      if (captureBudgetReached) return;
      updateMeasuredScroll();
      for (const container of detected) {
        if (!container.isConnected) continue;
        let bySlot = snapshots.get(container);
        if (bySlot === undefined) {
          bySlot = new Map<string, CaptureNode>();
          snapshots.set(container, bySlot);
        }
        for (const child of visibleVirtualChildren(container)) {
          const rect = child.getBoundingClientRect();
          const pageX = rect.left + window.scrollX;
          const pageY = rect.top + window.scrollY;
          const slot = `${Math.round(pageX * 2) / 2}:${Math.round(pageY * 2) / 2}:${Math.round(rect.width * 2) / 2}`;
          if (bySlot.has(slot)) continue;
          const captured = walkElement(child);
          if (captured !== null) bySlot.set(slot, captured);
          if (nodeCount >= maxNodes) {
            captureBudgetReached = true;
            break;
          }
        }
      }
    }, scanMaximumScroll);
    for (const [container, bySlot] of snapshots) {
      const children = Array.from(bySlot.values()).sort(
        (left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x,
      );
      if (children.length > 0) virtualizedCapturedChildren.set(container, children);
    }
    await restoreVirtualScanOrigin();
    const virtualCaptureTruncated = truncated || captureBudgetReached;
    nodeCount = 0;
    textNodeCount = 0;
    imageNodeCount = 0;
    truncated = false;
    return {
      incomplete:
        !captureScan.reachedBoundary ||
        detected.some((container) => !container.isConnected) ||
        snapshots.size !== detected.length,
      truncated: virtualCaptureTruncated,
    };
  }

  // -------------------------------------------------------------------------
  // Root assembly
  // -------------------------------------------------------------------------

  const body = document.body;
  const bodyStyle = getComputedStyle(body);
  const htmlStyle = getComputedStyle(document.documentElement);
  const pageBackground =
    parseColor(bodyStyle.backgroundColor) ??
    parseColor(htmlStyle.backgroundColor) ?? { r: 1, g: 1, b: 1, a: 1 };

  const extractionRoot: HTMLElement = body;

  const virtualRetention = await retainVirtualizedDocumentChildren();

  let pageWidth = capturePageWidth;
  let pageHeight = capturePageHeight;

  let rootNode = walkElement(extractionRoot);

  function shiftNode(node: CaptureNode, dx: number, dy: number): void {
    node.bounds = {
      ...node.bounds,
      x: node.bounds.x - dx,
      y: node.bounds.y - dy,
    };
    if (node.layoutBounds !== undefined) {
      node.layoutBounds = {
        ...node.layoutBounds,
        x: node.layoutBounds.x - dx,
        y: node.layoutBounds.y - dy,
      };
    }
    if (node.clipBounds !== undefined) {
      node.clipBounds = {
        ...node.clipBounds,
        x: node.clipBounds.x - dx,
        y: node.clipBounds.y - dy,
      };
    }
    if (node.type === "element") {
      if (node.fragmentRects !== undefined) {
        node.fragmentRects = node.fragmentRects.map((rect) => ({
          ...rect,
          x: rect.x - dx,
          y: rect.y - dy,
        }));
      }
      for (const child of node.children) shiftNode(child, dx, dy);
    } else if (node.type === "text" && node.measuredLines !== undefined) {
      node.measuredLines = node.measuredLines.map((line) => ({
        ...line,
        x: line.x - dx,
        y: line.y - dy,
      }));
    }
  }

  function validViewportClip(rect: PageRect | undefined): PageRect | null {
    if (
      rect === undefined ||
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function rectIntersectsViewport(rect: PageRect, clip: PageRect): boolean {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.x < clip.x + clip.width &&
      rect.x + rect.width > clip.x &&
      rect.y < clip.y + clip.height &&
      rect.y + rect.height > clip.y
    );
  }

  function retainViewportContributors(
    node: CaptureNode,
    clip: PageRect,
    forceRetain = false,
  ): CaptureNode | null {
    if (node.type !== "element") {
      return rectIntersectsViewport(node.bounds, clip) ? node : null;
    }
    node.children = node.children.flatMap((child) => {
      const retained = retainViewportContributors(child, clip);
      return retained ? [retained] : [];
    });
    return forceRetain || rectIntersectsViewport(node.bounds, clip) || node.children.length > 0
      ? node
      : null;
  }

  function collectRetainedFacts(
    node: CaptureNode,
    facts: {
      nodeIds: Set<string>;
      assetIds: Set<string>;
      nodeCount: number;
      textNodeCount: number;
      imageNodeCount: number;
    },
  ): void {
    facts.nodeIds.add(node.id);
    facts.nodeCount += 1;
    if (node.type === "text") {
      facts.textNodeCount += 1;
      if (node.fontFallbackAssetId !== undefined) {
        facts.assetIds.add(node.fontFallbackAssetId);
      }
      for (const fill of node.fillClip?.fills ?? []) {
        if (fill.type === "image") facts.assetIds.add(fill.assetId);
      }
      return;
    }
    if (node.type === "image") {
      facts.imageNodeCount += 1;
      if (node.assetId !== undefined) facts.assetIds.add(node.assetId);
      return;
    }
    if (node.type === "svg") {
      if (node.assetId !== undefined) facts.assetIds.add(node.assetId);
      return;
    }
    for (const fill of node.fills) {
      if (fill.type === "image") facts.assetIds.add(fill.assetId);
    }
    for (const child of node.children) collectRetainedFacts(child, facts);
  }

  const genericFontFamilies = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "emoji",
    "math",
    "fangsong",
  ]);

  function normalizeFontFamily(value: string): string {
    return value.replace(/^["']|["']$/g, "").trim();
  }

  async function annotateRenderedFontFamilies(node: CaptureNode): Promise<void> {
    const styles = new Set<TextStyle>();
    const collectStyles = (candidate: CaptureNode): void => {
      if (candidate.type === "text") {
        styles.add(candidate.style);
        for (const segment of candidate.segments) styles.add(segment.style);
        return;
      }
      if (candidate.type === "element") {
        for (const child of candidate.children) collectStyles(child);
      }
    };
    collectStyles(node);

    const declaredAvailability = new Map<string, boolean>();
    try {
      document.fonts.forEach((fontFace) => {
        const key = normalizeFontFamily(fontFace.family).toLowerCase();
        const loaded = fontFace.status === "loaded";
        declaredAvailability.set(key, (declaredAvailability.get(key) ?? false) || loaded);
      });
    } catch {
      return;
    }

    const families = new Map<string, string>();
    for (const style of styles) {
      for (const rawFamily of splitTopLevel(style.fontFamilyStack, ",")) {
        const family = normalizeFontFamily(rawFamily);
        const key = family.toLowerCase();
        if (family.length > 0 && !genericFontFamilies.has(key)) {
          families.set(key, family);
        }
      }
    }

    // A CSS family absent from document.fonts may still be an installed local
    // font (Arial, Helvetica, etc.). FontFace(local(...)).load() asks the
    // browser directly; no glyph-shape or string-width inference is involved.
    const localCandidates = Array.from(families.entries())
      .filter(([key]) => !declaredAvailability.has(key))
      .slice(0, 128);
    if (typeof FontFace !== "undefined") {
      await Promise.all(
        localCandidates.map(async ([key, family], index) => {
          const escaped = family.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
          try {
            const probe = new FontFace(`__web2ui_local_${index}`, `local("${escaped}")`);
            await probe.load();
            declaredAvailability.set(key, true);
          } catch {
            declaredAvailability.set(key, false);
          }
        }),
      );
    }

    for (const style of styles) {
      const stack = splitTopLevel(style.fontFamilyStack, ",")
        .map(normalizeFontFamily)
        .filter((family) => family.length > 0);
      let renderedFamily: string | undefined;
      for (const family of stack) {
        const key = family.toLowerCase();
        if (genericFontFamilies.has(key) || declaredAvailability.get(key) === true) {
          renderedFamily = genericFontFamilies.has(key) ? key : family;
          break;
        }
        if (!declaredAvailability.has(key)) {
          // Probe budget exhausted or FontFace unavailable: preserve the old
          // primary-family behavior instead of inventing a fallback.
          renderedFamily = style.fontFamily;
          break;
        }
      }
      renderedFamily ??= "serif";
      if (renderedFamily.toLowerCase() !== style.fontFamily.toLowerCase()) {
        style.renderedFontFamily = renderedFamily;
      }
    }
  }

  // Visible-area mode clips nodes outside the viewport and rebases every
  // browser-measured fact to the viewport's top-left corner.
  const viewportClip = validViewportClip(options.viewportClip);
  if (viewportClip && rootNode && rootNode.type === "element") {
    rootNode = retainViewportContributors(rootNode, viewportClip, true) as CaptureElementNode;
    shiftNode(rootNode, viewportClip.x, viewportClip.y);
    pageWidth = Math.ceil(viewportClip.width);
    pageHeight = Math.ceil(viewportClip.height);
  }
  const root: CaptureElementNode =
    rootNode && rootNode.type === "element"
      ? rootNode
      : {
          id: nextNodeId(),
          type: "element",
          tag: "body",
          name: "body",
          bounds: { x: 0, y: 0, width: pageWidth, height: pageHeight },
          opacity: 1,
          clipsContent: false,
          fills: [],
          children: [],
        };
  // Force root to cover the full page.
  root.bounds = { x: 0, y: 0, width: pageWidth, height: pageHeight };
  if (viewportClip) {
    root.clipsContent = true;
    root.clipAxes = { x: true, y: true };
  }
  if (virtualRetention.incomplete) {
    addWarning(
      "lazy_content_incomplete",
      "virtualized document scan ended before every observed band was retained",
    );
  }
  truncated = truncated || virtualRetention.truncated;
  function retainedTreeFacts(): {
    nodeIds: Set<string>;
    assetIds: Set<string>;
    nodeCount: number;
    textNodeCount: number;
    imageNodeCount: number;
  } {
    const facts = {
      nodeIds: new Set<string>(),
      assetIds: new Set<string>(),
      nodeCount: 0,
      textNodeCount: 0,
      imageNodeCount: 0,
    };
    collectRetainedFacts(root, facts);
    return facts;
  }

  async function annotateBackgroundIntrinsicSizes(node: CaptureNode): Promise<void> {
    const neededAssetIds = new Set<string>();
    const paintsByAssetId = new Map<
      string,
      Array<Extract<Paint, { type: "image" }>>
    >();
    const visit = (candidate: CaptureNode): void => {
      if (candidate.type !== "element") return;
      for (const fill of candidate.fills) {
        if (fill.type !== "image") continue;
        const explicitWidth = fill.tileSizePx?.width;
        const explicitHeight = fill.tileSizePx?.height;
        const needsRatio =
          (explicitWidth !== undefined) !== (explicitHeight !== undefined) &&
          (fill.naturalWidth === undefined || fill.naturalHeight === undefined);
        const needsPositionedBackgroundSize =
          fill.scaleMode === "crop" &&
          fill.repeat === "no-repeat" &&
          fill.backgroundPosition !== undefined &&
          (fill.naturalWidth === undefined || fill.naturalHeight === undefined);
        if (needsRatio || needsPositionedBackgroundSize) {
          neededAssetIds.add(fill.assetId);
          const paints = paintsByAssetId.get(fill.assetId) ?? [];
          paints.push(fill);
          paintsByAssetId.set(fill.assetId, paints);
        }
      }
      for (const child of candidate.children) visit(child);
    };
    visit(node);
    if (neededAssetIds.size === 0) return;

    const candidates: Array<{
      source: string;
      setSize: (width: number, height: number) => void;
    }> = [];
    for (const request of assetRequests) {
      if (!neededAssetIds.has(request.assetId)) continue;
      candidates.push({
        source: request.url,
        setSize: (width, height) => {
          request.naturalWidth = width;
          request.naturalHeight = height;
          for (const paint of paintsByAssetId.get(request.assetId) ?? []) {
            paint.naturalWidth = width;
            paint.naturalHeight = height;
          }
        },
      });
    }
    for (const asset of inlineAssets) {
      if (!neededAssetIds.has(asset.assetId)) continue;
      const source = asset.data.startsWith("data:")
        ? asset.data
        : asset.mediaType === "image/svg+xml"
          ? `data:image/svg+xml,${encodeURIComponent(asset.data)}`
          : null;
      if (source === null) continue;
      candidates.push({
        source,
        setSize: (width, height) => {
          asset.naturalWidth = width;
          asset.naturalHeight = height;
          for (const paint of paintsByAssetId.get(asset.assetId) ?? []) {
            paint.naturalWidth = width;
            paint.naturalHeight = height;
          }
        },
      });
    }
    await Promise.all(
      candidates.slice(0, 64).map(
        (candidate) =>
          new Promise<void>((resolve) => {
            const image = new Image();
            image.decoding = "async";
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                candidate.setSize(image.naturalWidth, image.naturalHeight);
              }
              resolve();
            };
            const timer = setTimeout(finish, 1_500);
            image.addEventListener("load", finish, { once: true });
            image.addEventListener("error", finish, { once: true });
            image.src = candidate.source;
            if (image.complete) finish();
          }),
      ),
    );
  }

  let retainedFacts = retainedTreeFacts();
  if (retainedFacts.nodeCount > maxNodes && virtualizedInsertedNodes.length > 0) {
    // Segmented items were measured before the final base walk, so attaching
    // their subtrees can make the retained tree exceed the shared node cap.
    // Drop complete bottom-most items until the actual returned tree is back
    // within budget; never leave a partially captured item subtree behind.
    const bottomFirst = [...virtualizedInsertedNodes].sort(
      (left, right) =>
        right.node.bounds.y - left.node.bounds.y || right.node.bounds.x - left.node.bounds.x,
    );
    for (const inserted of bottomFirst) {
      if (retainedFacts.nodeCount <= maxNodes) break;
      const index = inserted.parent.children.indexOf(inserted.node);
      if (index < 0) continue;
      inserted.parent.children.splice(index, 1);
      truncated = true;
      retainedFacts = retainedTreeFacts();
    }
  }
  nodeCount = retainedFacts.nodeCount;
  textNodeCount = retainedFacts.textNodeCount;
  imageNodeCount = retainedFacts.imageNodeCount;
  assetRequests.splice(
    0,
    assetRequests.length,
    ...assetRequests.filter((request) => retainedFacts.assetIds.has(request.assetId)),
  );
  inlineAssets.splice(
    0,
    inlineAssets.length,
    ...inlineAssets.filter((asset) => retainedFacts.assetIds.has(asset.assetId)),
  );
  await annotateBackgroundIntrinsicSizes(root);
  for (const [key, warning] of warningCounts) {
    if (warning.nodeId !== undefined && !retainedFacts.nodeIds.has(warning.nodeId)) {
      warningCounts.delete(key);
    }
  }

  if (truncated) {
    addWarning("node_limit_truncated", `capped at ${maxNodes} nodes`);
  }

  await annotateRenderedFontFamilies(root);
  annotatePaintOrderFacts(root);

  // Fonts actually used.
  const fontMap = new Map<string, CaptureFont>();
  try {
    document.fonts.forEach((fontFace) => {
      const family = fontFace.family.replace(/["']/g, "");
      const loaded = fontFace.status === "loaded";
      // Variable faces report weight as "100 900". parseInt would collapse that
      // to 100 and invent a Thin face; skip discrete weights for ranges and let
      // the text-style pass below record the weights that actually painted.
      const weightToken = String(fontFace.weight).trim();
      const isVariableRange = /^\d+\s+\d+$/.test(weightToken);
      const weight = isVariableRange ? undefined : Number.parseInt(weightToken, 10) || 400;
      // Only loaded italic faces count — unloaded italic companions on variable
      // families used to flip italicUsed and skew the font manifest.
      const italic = loaded && fontFace.style === "italic";
      const existing = fontMap.get(family);
      if (existing) {
        if (weight !== undefined && !existing.weightsUsed.includes(weight)) {
          existing.weightsUsed.push(weight);
        }
        existing.italicUsed = existing.italicUsed || italic;
        existing.loaded = existing.loaded || loaded;
      } else {
        fontMap.set(family, {
          family,
          weightsUsed: weight !== undefined ? [weight] : [],
          italicUsed: italic,
          loaded,
        });
      }
    });
    // Fill weightsUsed from authored text styles (especially variable fonts).
    const collectTextWeights = (node: CaptureNode): void => {
      if (node.type === "text") {
        const family = node.style?.fontFamily;
        const weight = node.style?.fontWeight;
        if (family && typeof weight === "number" && Number.isFinite(weight)) {
          const existing = fontMap.get(family);
          if (existing && !existing.weightsUsed.includes(weight)) {
            existing.weightsUsed.push(weight);
          }
        }
        for (const segment of node.segments ?? []) {
          const segFamily = segment.style?.fontFamily ?? family;
          const segWeight = segment.style?.fontWeight;
          if (
            segFamily &&
            typeof segWeight === "number" &&
            Number.isFinite(segWeight)
          ) {
            const existing = fontMap.get(segFamily);
            if (existing && !existing.weightsUsed.includes(segWeight)) {
              existing.weightsUsed.push(segWeight);
            }
          }
        }
      }
      if (node.type === "element") {
        for (const child of node.children) {
          collectTextWeights(child);
        }
      }
    };
    collectTextWeights(root);
  } catch {
    addWarning("font_not_loaded", "document.fonts unavailable");
  }

  const warnings: CaptureWarning[] = [];
  for (const entry of warningCounts.values()) {
    warnings.push({
      code: entry.code as CaptureWarning["code"],
      count: entry.count,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      ...(entry.nodeId !== undefined ? { nodeId: entry.nodeId } : {}),
    });
  }

  return {
    root,
    assetRequests,
    inlineAssets,
    fonts: Array.from(fontMap.values()),
    warnings,
    pageWidth,
    pageHeight,
    pageBackground,
    nodeCount,
    textNodeCount,
    imageNodeCount,
  };
}
