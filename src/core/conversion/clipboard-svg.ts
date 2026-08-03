/**
 * Render-plan -> Figma clipboard SVG adapter.
 *
 * This is intentionally an output adapter, not a second conversion engine.
 * The canonical HTML/capture -> Figma semantic step stays in convert.ts.
 */
import type {
  FigmaEffect,
  FigmaGradientPaint,
  FigmaPaint,
  RenderPlan,
  RenderPlanFrameNode,
  RenderPlanNode,
  RenderPlanRectangleNode,
  RenderPlanTextNode,
  RenderPlanVectorNode,
} from "../contracts/render-plan.js";
import type { RgbaColor } from "../contracts/capture.js";
import { isSafeSvgMarkup } from "../contracts/capture.js";

export interface FigmaClipboardPayload {
  svg: string;
  html: string;
  text: string;
}

interface ClipboardAsset {
  href: string;
  mediaType: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

interface SvgContext {
  assetsById: Map<string, ClipboardAsset>;
  fontFallbackByFamily: Map<string, string>;
  defs: string[];
  sequence: number;
}

export async function renderPlanToFigmaClipboardPayload(plan: RenderPlan): Promise<FigmaClipboardPayload> {
  const svg = await renderPlanToSvg(plan);
  return {
    svg,
    html: `<!doctype html><html><body>${svg}</body></html>`,
    text: svg,
  };
}

export async function renderPlanToSvg(plan: RenderPlan): Promise<string> {
  const context: SvgContext = {
    assetsById: collectAssetsById(plan),
    fontFallbackByFamily: collectFontFallbacks(plan),
    defs: [],
    sequence: 0,
  };

  const body = renderFrameChildren(plan.root, context);
  const background = colorToCss(plan.page.background);
  const defs = context.defs.length > 0 ? `<defs>${context.defs.join("")}</defs>` : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(plan.page.widthPx)}" height="${num(
      plan.page.heightPx,
    )}" viewBox="0 0 ${num(plan.page.widthPx)} ${num(plan.page.heightPx)}">`,
    `<rect width="100%" height="100%" fill="${background.color}" fill-opacity="${num(
      background.opacity,
    )}"/>`,
    defs,
    body,
    "</svg>",
  ].join("");
}

function collectAssetsById(plan: RenderPlan): Map<string, ClipboardAsset> {
  const resolved: Array<[string, ClipboardAsset]> = [];
  for (const asset of plan.assets) {
    if (asset.ref.kind === "url") {
      if (!asset.ref.url.startsWith("data:")) {
        throw new Error("clipboard SVG only accepts inline data assets");
      }
      resolved.push([
        asset.assetId,
        {
          href: asset.ref.url,
          mediaType: asset.mediaType.toLowerCase(),
          ...(asset.naturalWidth !== undefined ? { naturalWidth: asset.naturalWidth } : {}),
          ...(asset.naturalHeight !== undefined ? { naturalHeight: asset.naturalHeight } : {}),
        },
      ]);
    }
  }
  return new Map(resolved);
}

function collectFontFallbacks(plan: RenderPlan): Map<string, string> {
  return new Map(
    plan.fonts.map((font) => [normalizeFontFamily(font.family), font.fallbackFamily]),
  );
}

function normalizeFontFamily(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function renderFrameChildren(frame: RenderPlanFrameNode, context: SvgContext): string {
  return frame.children.map((child) => renderNode(child, context)).join("");
}

function renderNode(node: RenderPlanNode, context: SvgContext): string {
  if (node.visible === false) return "";
  switch (node.type) {
    case "FRAME":
      return renderFrame(node, context);
    case "RECTANGLE":
      return renderRectangle(node, context);
    case "TEXT":
      return renderText(node, context);
    case "SVG":
      return renderVector(node, context);
    default:
      return "";
  }
}

function renderFrame(node: RenderPlanFrameNode, context: SvgContext): string {
  const rects = renderPaintedRect(node, context);
  const children = renderFrameChildren(node, context);
  const content = `${rects}${children}`;
  return wrapPositioned(node, node.clipsContent ? withClip(node, content, context) : content);
}

function renderRectangle(node: RenderPlanRectangleNode, context: SvgContext): string {
  return wrapPositioned(node, renderPaintedRect(node, context));
}

function renderPaintedRect(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  context: SvgContext,
): string {
  const width = Math.max(0.01, node.width);
  const height = Math.max(0.01, node.height);
  const effectAttrs = effectFilterAttributes(node.effects, context);
  const fills = node.fills;
  const renderedFills = fills
    .map((paint, index) =>
      renderFill(node, paint, context, width, height, index === 0 ? effectAttrs : ""),
    )
    .filter(Boolean)
    .join("");
  const stroke = renderStroke(node, fills.length === 0 ? effectAttrs : "");
  // Empty frames still need a paint box when they carry an effect. A fully
  // transparent rect is harmless and keeps the SVG bounds deterministic.
  const effectOnly =
    fills.length === 0 && !stroke && effectAttrs
      ? shapeElement(node, `fill="none"${effectAttrs}`)
      : "";
  return `${renderedFills}${stroke}${effectOnly}`;
}

function renderText(node: RenderPlanTextNode, context: SvgContext): string {
  // Figma's SVG paste path cannot load arbitrary site webfonts. The canonical
  // render plan remains editable TEXT (and the plugin still performs a
  // target-font capability check), while this clipboard-only adapter uses the
  // extractor's measured glyph pixels when they exist. Ordinary system/generic
  // text never receives this optional asset and therefore stays SVG <text>.
  if (node.fontFallbackAssetId) {
    const fallback = context.assetsById.get(node.fontFallbackAssetId);
    if (fallback && fallback.mediaType.startsWith("image/") && fallback.mediaType !== "image/svg+xml") {
      const effects = effectFilterAttributes(node.effects, context);
      return wrapPositioned(
        node,
        `<image href="${escapeAttr(fallback.href)}" width="${num(node.width)}" height="${num(
          node.height,
        )}" preserveAspectRatio="none"${effects}/>`,
      );
    }
  }

  // Compatibility path for older render plans that predate captured glyph
  // assets. Keeping the original TEXT is better than silently deleting it.
  const fontFamily =
    context.fontFallbackByFamily.get(normalizeFontFamily(node.fontFamily)) ?? node.fontFamily;
  const x = textAnchorX(node);
  const anchor =
    node.textAlignHorizontal === "CENTER"
      ? "middle"
      : node.textAlignHorizontal === "RIGHT"
        ? "end"
        : "start";
  const lines = node.characters.split(/\n/);
  let globalOffset = 0;
  const tspans = lines
    .map((line, index) => {
      const lineStart = globalOffset;
      globalOffset += line.length + (index < lines.length - 1 ? 1 : 0);
      // Keep each line independent: Figma can accumulate relative tspan
      // offsets differently once a line contains nested style spans.
      const baselineY = node.fontSizePx + index * node.lineHeightPx;
      return `<tspan x="${num(x)}" y="${num(baselineY)}">${renderTextLineSegments(
        node,
        line,
        lineStart,
        fontFamily,
        context.fontFallbackByFamily,
      )}</tspan>`;
    })
    .join("");
  const fill = firstSolidColor(node.fills) ?? { color: "#000000", opacity: 1 };
  const baseDecoration = node.textDecoration === "NONE" ? "none" : node.textDecoration.toLowerCase();
  const effects = effectFilterAttributes(node.effects, context);
  const fontStyle = figmaStyleToCssFontStyle(node.fontStyle);
  return wrapPositioned(
    node,
    `<text x="${num(x)}" y="0" font-family="${escapeAttr(fontFamily)}" font-size="${num(
      node.fontSizePx,
    )}" font-weight="${escapeAttr(figmaStyleToCssWeight(node.fontStyle))}" font-style="${fontStyle}" text-anchor="${anchor}" fill="${
      fill.color
    }" fill-opacity="${num(fill.opacity)}" text-decoration="${baseDecoration}" letter-spacing="${num(
      node.letterSpacingPx,
    )}"${effects}>${tspans}</text>`,
  );
}

function renderTextLineSegments(
  node: RenderPlanTextNode,
  line: string,
  lineStart: number,
  fallbackFamily: string,
  fallbackByFamily: Map<string, string>,
): string {
  if (line.length === 0) return "";
  if (node.segments === undefined || node.segments.length === 0) {
    return escapeText(line);
  }
  const lineEnd = lineStart + line.length;
  const pieces: string[] = [];
  let cursor = lineStart;
  const segments = [...node.segments].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const segment of segments) {
    const start = Math.max(lineStart, segment.start);
    const end = Math.min(lineEnd, segment.end);
    if (end <= start) continue;
    if (start > cursor) {
      pieces.push(escapeText(node.characters.slice(cursor, start)));
    }
    const visibleStart = Math.max(start, cursor);
    if (end <= visibleStart) continue;
    const text = node.characters.slice(visibleStart, end);
    if (text.length === 0) continue;
    const family =
      fallbackByFamily.get(normalizeFontFamily(segment.fontFamily)) ??
      (normalizeFontFamily(segment.fontFamily) === normalizeFontFamily(node.fontFamily)
        ? fallbackFamily
        : segment.fontFamily);
    const color = colorToCss(segment.color);
    const decoration =
      segment.textDecoration === "NONE" ? "none" : segment.textDecoration.toLowerCase();
    pieces.push(
      `<tspan font-family="${escapeAttr(family)}" font-size="${num(
        segment.fontSizePx,
      )}" font-weight="${escapeAttr(figmaStyleToCssWeight(segment.fontStyle))}" font-style="${figmaStyleToCssFontStyle(
        segment.fontStyle,
      )}" fill="${
        color.color
      }" fill-opacity="${num(color.opacity)}" letter-spacing="${num(
        segment.letterSpacingPx,
      )}" text-decoration="${decoration}">${escapeText(text)}</tspan>`,
    );
    cursor = end;
  }
  if (cursor < lineEnd) {
    pieces.push(escapeText(node.characters.slice(cursor, lineEnd)));
  }
  return pieces.length > 0 ? pieces.join("") : escapeText(line);
}

function renderVector(node: RenderPlanVectorNode, context: SvgContext): string {
  if (node.svgMarkup) {
    // Figma drops <image href="data:image/svg+xml,..."> during paste. The
    // capture already contains safe, self-contained markup, so keep it as
    // vector XML and namespace local fragment ids before composing documents.
    if (!isSafeSvgMarkup(node.svgMarkup)) {
      throw new Error("clipboard SVG rejected unsafe markup");
    } else {
      const fitted = fitInlineSvgMarkup(
        namespaceInlineSvgMarkup(node.svgMarkup, context),
        node.width,
        node.height,
      );
      return wrapPositioned(node, fitted);
    }
  }
  if (node.assetId) {
    const asset = context.assetsById.get(node.assetId);
    if (asset) {
      return wrapPositioned(
        node,
        `<image href="${escapeAttr(asset.href)}" width="${num(node.width)}" height="${num(
          node.height,
        )}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    }
  }
  return "";
}

function fitInlineSvgMarkup(markup: string, width: number, height: number): string {
  // XML declarations and doctypes are valid only at the document root. A
  // captured inline SVG is embedded inside the clipboard document's outer
  // <svg>; leaving either prolog in place makes the resulting XML invalid and
  // causes Figma to drop the vector silently.
  const embedded = markup
    .replace(/^\s*\uFEFF?\s*<\?xml\b[^>]*\?>\s*/i, "")
    .replace(/^\s*<!DOCTYPE\b[^>]*>\s*/i, "");
  const opening = /<svg\b([^>]*)>/i.exec(embedded);
  if (!opening || opening.index === undefined) return embedded;
  const rawAttrs = opening[1] ?? "";
  const selfClosing = /\/\s*$/.test(rawAttrs);
  const attrs = rawAttrs.replace(/\/\s*$/, "");
  const viewBox = readSvgAttribute(attrs, "viewBox");
  const intrinsicWidth = parseSvgLength(readSvgAttribute(attrs, "width"));
  const intrinsicHeight = parseSvgLength(readSvgAttribute(attrs, "height"));
  const canonicalViewBox =
    viewBox ??
    `0 0 ${num(intrinsicWidth ?? Math.max(width, 1))} ${num(
      intrinsicHeight ?? Math.max(height, 1),
    )}`;
  const retained = attrs
    .replace(/\s+(?:width|height|x|y|viewBox|preserveAspectRatio)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .trim();
  const canonical = [
    retained,
    `width="${num(Math.max(width, 0.01))}"`,
    `height="${num(Math.max(height, 0.01))}"`,
    `viewBox="${escapeAttr(canonicalViewBox)}"`,
    'preserveAspectRatio="xMidYMid meet"',
  ]
    .filter(Boolean)
    .join(" ");
  const start = opening.index;
  const end = start + opening[0].length;
  const suffix = embedded.slice(end);
  return selfClosing
    ? `${embedded.slice(0, start)}<svg ${canonical}></svg>${suffix}`
    : `${embedded.slice(0, start)}<svg ${canonical}>${suffix}`;
}

function readSvgAttribute(attrs: string, name: string): string | null {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function parseSvgLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:px)?\s*$/i.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function namespaceInlineSvgMarkup(markup: string, context: SvgContext): string {
  const prefix = nextDefId(context, "svg");
  const ids = new Map<string, string>();
  const idPattern = /\bid\s*=\s*(["'])([^"'<>]+)\1/g;
  for (const match of markup.matchAll(idPattern)) {
    const id = match[2];
    if (id) ids.set(id, `${prefix}-${id}`);
  }
  if (ids.size === 0) return markup;

  let namespaced = markup;
  for (const [id, replacement] of ids) {
    const escaped = escapeRegExp(id);
    const urlReference = new RegExp(
      `url\\(\\s*(?:["']|&quot;|&apos;)?#${escaped}(?:["']|&quot;|&apos;)?\\s*\\)`,
      "g",
    );
    namespaced = namespaced.replace(urlReference, (value) =>
      value.replace(`#${id}`, `#${replacement}`),
    );
    const hrefReference = new RegExp(
      `(\\b(?:href|xlink:href)\\s*=\\s*["'])#${escaped}(["'])`,
      "g",
    );
    namespaced = namespaced.replace(hrefReference, `$1#${replacement}$2`);
  }
  return namespaced.replace(idPattern, (value, quote: string, id: string) => {
    const replacement = ids.get(id);
    return replacement ? `id=${quote}${replacement}${quote}` : value;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrapPositioned(
  node: {
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
    rotationDegrees?: number;
    visible?: boolean;
    blendMode?: string;
  },
  content: string,
): string {
  if (!content || node.visible === false) return "";
  const transforms = [`translate(${num(node.x)} ${num(node.y)})`];
  if (node.rotationDegrees !== undefined && node.rotationDegrees !== 0) {
    transforms.push(
      `rotate(${num(node.rotationDegrees)} ${num(node.width / 2)} ${num(node.height / 2)})`,
    );
  }
  const blend = cssBlendMode(node.blendMode);
  return `<g transform="${transforms.join(" ")}"${opacityAttr(node.opacity)}${
    blend ? ` style="mix-blend-mode:${blend}"` : ""
  }>${content}</g>`;
}

function withClip(node: RenderPlanFrameNode, content: string, context: SvgContext): string {
  const id = nextDefId(context, "clip");
  context.defs.push(
    `<clipPath id="${id}">${roundedShape(node, "")}</clipPath>`,
  );
  return `<g clip-path="url(#${id})">${content}</g>`;
}

function renderFill(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  paint: FigmaPaint,
  context: SvgContext,
  width: number,
  height: number,
  effectAttrs: string,
): string {
  if (paint.type === "IMAGE") {
    return renderImagePaint(node, paint, context, width, height, effectAttrs);
  }
  const fill = paintToFill(paint, context, width, height);
  if (!fill) return "";
  return shapeElement(node, `${fill}${effectAttrs}`);
}

function renderImagePaint(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  paint: Extract<FigmaPaint, { type: "IMAGE" }>,
  context: SvgContext,
  width: number,
  height: number,
  effectAttrs: string,
): string {
  const asset = context.assetsById.get(paint.assetId);
  if (!asset) return "";
  const clip = clipForNode(node, context);
  const opacity = opacityAttr(paint.opacity);
  if (paint.scaleMode === "TILE") {
    const naturalWidth = asset.naturalWidth ?? width;
    const naturalHeight = asset.naturalHeight ?? height;
    const scale =
      paint.scalingFactor !== undefined && Number.isFinite(paint.scalingFactor)
        ? Math.max(0.001, paint.scalingFactor)
        : 1;
    const tileWidth = Math.max(0.01, naturalWidth * scale);
    const tileHeight = Math.max(0.01, naturalHeight * scale);
    const patternId = nextDefId(context, "tile");
    context.defs.push(
      `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${num(
        tileWidth,
      )}" height="${num(tileHeight)}"><image href="${escapeAttr(
        asset.href,
      )}" width="${num(tileWidth)}" height="${num(tileHeight)}" preserveAspectRatio="none"/></pattern>`,
    );
    return shapeElement(node, `fill="url(#${patternId})"${opacity}${effectAttrs}${clip}`);
  }
  return `<image href="${escapeAttr(asset.href)}" width="${num(width)}" height="${num(
    height,
  )}" preserveAspectRatio="${imagePreserveAspectRatio(paint.scaleMode)}"${opacity}${clip}${effectAttrs}/>`;
}

function shapeElement(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  attrs: string,
  child?: string,
): string {
  const shape = roundedShape(node, attrs, child);
  return shape;
}

function roundedShape(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  attrs: string,
  child?: string,
): string {
  const width = Math.max(0.01, node.width);
  const height = Math.max(0.01, node.height);
  const radii = normalizedRadii(node, width, height);
  const body = child ?? "";
  const normalizedAttrs = attrs.trim().length > 0 ? ` ${attrs.trim()}` : "";
  if (radii.topLeft === radii.topRight && radii.topRight === radii.bottomRight && radii.bottomRight === radii.bottomLeft) {
    const radius = radii.topLeft > 0 ? ` rx="${num(radii.topLeft)}" ry="${num(radii.topLeft)}"` : "";
    return `<rect width="${num(width)}" height="${num(height)}"${radius}${normalizedAttrs}>${body}</rect>`;
  }
  const d = roundedRectPath(width, height, radii);
  return `<path d="${d}"${normalizedAttrs}>${body}</path>`;
}

function normalizedRadii(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  width: number,
  height: number,
): { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number } {
  const source = node.cornerRadii ?? {
    topLeft: node.cornerRadius ?? 0,
    topRight: node.cornerRadius ?? 0,
    bottomRight: node.cornerRadius ?? 0,
    bottomLeft: node.cornerRadius ?? 0,
  };
  const maxRadius = Math.min(width, height) / 2;
  return {
    topLeft: Math.min(Math.max(0, source.topLeft), maxRadius),
    topRight: Math.min(Math.max(0, source.topRight), maxRadius),
    bottomRight: Math.min(Math.max(0, source.bottomRight), maxRadius),
    bottomLeft: Math.min(Math.max(0, source.bottomLeft), maxRadius),
  };
}

function roundedRectPath(
  width: number,
  height: number,
  radii: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number },
): string {
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = radii;
  return [
    `M ${num(tl)} 0`,
    `H ${num(width - tr)}`,
    `A ${num(tr)} ${num(tr)} 0 0 1 ${num(width)} ${num(tr)}`,
    `V ${num(height - br)}`,
    `A ${num(br)} ${num(br)} 0 0 1 ${num(width - br)} ${num(height)}`,
    `H ${num(bl)}`,
    `A ${num(bl)} ${num(bl)} 0 0 1 0 ${num(height - bl)}`,
    `V ${num(tl)}`,
    `A ${num(tl)} ${num(tl)} 0 0 1 ${num(tl)} 0 Z`,
  ].join(" ");
}

function clipForNode(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  context: SvgContext,
): string {
  const radii = normalizedRadii(node, Math.max(0.01, node.width), Math.max(0.01, node.height));
  if (Object.values(radii).every((radius) => radius <= 0)) return "";
  const id = nextDefId(context, "image-clip");
  context.defs.push(`<clipPath id="${id}">${roundedShape(node, "")}</clipPath>`);
  return ` clip-path="url(#${id})"`;
}

function cssBlendMode(value: string | undefined): string | null {
  if (!value || value === "NORMAL") return null;
  return value.toLowerCase().replaceAll("_", "-");
}

function paintToFill(
  paint: Exclude<FigmaPaint, { type: "IMAGE" }>,
  context: SvgContext,
  width: number,
  height: number,
): string | null {
  if (paint.type === "SOLID") {
    const fill = colorToCss({ ...paint.color, a: paint.opacity });
    return ` fill="${fill.color}" fill-opacity="${num(fill.opacity)}"`;
  }
  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR"
  ) {
    const id = nextDefId(context, "grad");
    const stops = paint.gradientStops
      .map((stop) => {
        const color = colorToCss(stop.color);
        return `<stop offset="${num(stop.position * 100)}%" stop-color="${
          color.color
        }" stop-opacity="${num(color.opacity)}"/>`;
      })
      .join("");
    if (paint.type === "GRADIENT_RADIAL") {
      context.defs.push(
        `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" r="0.5"${gradientTransformAttr(
          paint,
        )}>${stops}</radialGradient>`,
      );
    } else if (paint.type === "GRADIENT_ANGULAR") {
      context.defs.push(renderAngularGradientPattern(id, paint));
      return ` fill="url(#${id})" fill-opacity="${num(paint.opacity)}"`;
    } else {
      context.defs.push(
        `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0" y1="0.5" x2="1" y2="0.5"${gradientTransformAttr(
          paint,
        )}>${stops}</linearGradient>`,
      );
    }
    return ` fill="url(#${id})" fill-opacity="${num(paint.opacity)}"`;
  }
  void width;
  void height;
  return null;
}

function gradientTransformAttr(paint: FigmaGradientPaint): string {
  const [[a, c, e], [b, d, f]] = paint.gradientTransform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return "";
  const inverseA = d / determinant;
  const inverseB = -b / determinant;
  const inverseC = -c / determinant;
  const inverseD = a / determinant;
  const inverseE = (c * f - d * e) / determinant;
  const inverseF = (b * e - a * f) / determinant;
  return ` gradientTransform="matrix(${num(inverseA)} ${num(inverseB)} ${num(inverseC)} ${num(inverseD)} ${num(inverseE)} ${num(inverseF)})"`;
}

/**
 * SVG 1.1 has no conic/angular gradient primitive. Approximate the canonical
 * Figma angular paint with a dense vector wedge pattern instead of silently
 * replacing it with a diagonal linear gradient. Pattern content must use the
 * same normalized coordinate system as the object-bounding-box pattern;
 * otherwise the 0..1 wedges collapse into the top-left pixel on large nodes.
 */
function renderAngularGradientPattern(
  id: string,
  paint: FigmaGradientPaint,
): string {
  const wedges: string[] = [];
  const count = 96;
  for (let index = 0; index < count; index += 1) {
    const start = (index / count) * Math.PI * 2 - Math.PI / 2;
    const end = ((index + 1) / count) * Math.PI * 2 - Math.PI / 2;
    const midpoint = (index + 0.5) / count;
    const color = gradientColorAt(paint, midpoint);
    const css = colorToCss(color);
    const x1 = 0.5 + Math.cos(start) * 1.5;
    const y1 = 0.5 + Math.sin(start) * 1.5;
    const x2 = 0.5 + Math.cos(end) * 1.5;
    const y2 = 0.5 + Math.sin(end) * 1.5;
    wedges.push(
      `<path d="M 0.5 0.5 L ${num(x1)} ${num(y1)} A 1.5 1.5 0 0 1 ${num(x2)} ${num(
        y2,
      )} Z" fill="${css.color}" fill-opacity="${num(css.opacity)}"/>`,
    );
  }
  return `<pattern id="${id}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1"${gradientTransformAttr(
    paint,
  )}>${wedges.join("")}</pattern>`;
}

function gradientColorAt(
  paint: FigmaGradientPaint,
  position: number,
): RgbaColor {
  const stops = [...paint.gradientStops].sort((a, b) => a.position - b.position);
  const first = stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 };
  if (stops.length === 0 || position <= (stops[0]?.position ?? 0)) return first;
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]!;
    const next = stops[index]!;
    if (position > next.position) continue;
    const span = Math.max(0.0001, next.position - previous.position);
    const t = clamp01((position - previous.position) / span);
    return {
      r: previous.color.r + (next.color.r - previous.color.r) * t,
      g: previous.color.g + (next.color.g - previous.color.g) * t,
      b: previous.color.b + (next.color.b - previous.color.b) * t,
      a: previous.color.a + (next.color.a - previous.color.a) * t,
    };
  }
  return stops[stops.length - 1]?.color ?? first;
}

function renderStroke(
  node: RenderPlanFrameNode | RenderPlanRectangleNode,
  effectAttrs: string,
): string {
  const stroke = firstSolidColor(node.strokes);
  if (!stroke) return "";
  const uniformAttrs = `fill="none" stroke="${stroke.color}" stroke-opacity="${num(
    stroke.opacity,
  )}" stroke-width="${num(node.strokeWeight)}"${effectAttrs}`;
  if (node.type !== "FRAME" || node.strokeWeights === undefined) {
    return node.strokeWeight > 0 ? shapeElement(node, uniformAttrs) : "";
  }

  const { top, right, bottom, left } = node.strokeWeights;
  if (top <= 0 && right <= 0 && bottom <= 0 && left <= 0) return "";
  if (top === right && right === bottom && bottom === left) {
    return top > 0
      ? shapeElement(
          node,
          `fill="none" stroke="${stroke.color}" stroke-opacity="${num(
            stroke.opacity,
          )}" stroke-width="${num(top)}"${effectAttrs}`,
        )
      : "";
  }

  // Figma exposes one stroke paint plus four measured side widths. Emit each
  // side independently so Copy preserves input/select and asymmetric card
  // borders instead of expanding the maximum width around all four sides.
  const width = Math.max(0.01, node.width);
  const height = Math.max(0.01, node.height);
  const attrs = `stroke="${stroke.color}" stroke-opacity="${num(
    stroke.opacity,
  )}" fill="none"`;
  const lines = [
    top > 0
      ? `<line x1="0" y1="${num(top / 2)}" x2="${num(width)}" y2="${num(
          top / 2,
        )}" ${attrs} stroke-width="${num(top)}"/>`
      : "",
    right > 0
      ? `<line x1="${num(width - right / 2)}" y1="0" x2="${num(
          width - right / 2,
        )}" y2="${num(height)}" ${attrs} stroke-width="${num(right)}"/>`
      : "",
    bottom > 0
      ? `<line x1="0" y1="${num(height - bottom / 2)}" x2="${num(
          width,
        )}" y2="${num(height - bottom / 2)}" ${attrs} stroke-width="${num(
          bottom,
        )}"/>`
      : "",
    left > 0
      ? `<line x1="${num(left / 2)}" y1="0" x2="${num(left / 2)}" y2="${num(
          height,
        )}" ${attrs} stroke-width="${num(left)}"/>`
      : "",
  ].join("");
  return effectAttrs ? `<g${effectAttrs}>${lines}</g>` : lines;
}

function effectFilterAttributes(effects: FigmaEffect[], context: SvgContext): string {
  const visible = effects;
  if (visible.length === 0) return "";
  const id = nextDefId(context, "shadow");
  const primitives: string[] = [];
  const behind: string[] = [];
  const inFront: string[] = [];
  let base = "SourceGraphic";
  let sequence = 0;

  for (const effect of visible) {
    sequence += 1;
    if (effect.type === "LAYER_BLUR") {
      const result = `effect-${sequence}`;
      primitives.push(
        `<feGaussianBlur in="${base}" stdDeviation="${num(effect.radius / 2)}" result="${result}"/>`,
      );
      base = result;
      continue;
    }
    if (effect.type === "BACKGROUND_BLUR") {
      const result = `effect-${sequence}`;
      primitives.push(
        `<feGaussianBlur in="BackgroundImage" stdDeviation="${num(effect.radius / 2)}" result="${result}"/>`,
      );
      behind.push(result);
      continue;
    }
    if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") {
      continue;
    }

    const color = colorToCss(effect.color);
    if (effect.type === "DROP_SHADOW") {
      const result = `effect-${sequence}`;
      primitives.push(
        `<feDropShadow in="${base}" dx="${num(effect.offset.x)}" dy="${num(
          effect.offset.y,
        )}" stdDeviation="${num(effect.radius / 2)}" flood-color="${
          color.color
        }" flood-opacity="${num(color.opacity)}" result="${result}"/>`,
      );
      behind.push(result);
      continue;
    }

    const blurred = `effect-${sequence}-blur`;
    const offset = `effect-${sequence}-offset`;
    const mask = `effect-${sequence}-mask`;
    const flood = `effect-${sequence}-flood`;
    const result = `effect-${sequence}`;
    primitives.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${num(effect.radius / 2)}" result="${blurred}"/>`,
      `<feOffset in="${blurred}" dx="${num(effect.offset.x)}" dy="${num(
        effect.offset.y,
      )}" result="${offset}"/>`,
      `<feComposite in="SourceAlpha" in2="${offset}" operator="out" result="${mask}"/>`,
      `<feFlood flood-color="${color.color}" flood-opacity="${num(
        color.opacity,
      )}" result="${flood}"/>`,
      `<feComposite in="${flood}" in2="${mask}" operator="in" result="${result}"/>`,
    );
    inFront.push(result);
  }

  const merge = [...behind, base, ...inFront]
    .map((result) => `<feMergeNode in="${result}"/>`)
    .join("");
  context.defs.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${primitives.join(
      "",
    )}<feMerge>${merge}</feMerge></filter>`,
  );
  return ` filter="url(#${id})"`;
}

function firstSolidColor(paints: FigmaPaint[]): { color: string; opacity: number } | null {
  const solid = paints.find((paint) => paint.type === "SOLID");
  if (!solid || solid.type !== "SOLID") return null;
  return colorToCss({ ...solid.color, a: solid.opacity });
}

function imagePreserveAspectRatio(scaleMode: "FILL" | "FIT" | "CROP" | "TILE"): string {
  if (scaleMode === "FIT") return "xMidYMid meet";
  if (scaleMode === "TILE") return "none";
  return "xMidYMid slice";
}

function textAnchorX(node: RenderPlanTextNode): number {
  if (node.textAlignHorizontal === "CENTER") return node.width / 2;
  if (node.textAlignHorizontal === "RIGHT") return node.width;
  return 0;
}

function figmaStyleToCssWeight(style: string): string {
  const normalized = style.toLowerCase();
  if (normalized.includes("black")) return "900";
  if (normalized.includes("extra bold") || normalized.includes("extrabold")) return "800";
  if (normalized.includes("bold")) return "700";
  if (normalized.includes("semi")) return "600";
  if (normalized.includes("medium")) return "500";
  if (normalized.includes("light")) return "300";
  return "400";
}

function figmaStyleToCssFontStyle(style: string): "normal" | "italic" | "oblique" {
  const normalized = style.toLowerCase();
  if (normalized.includes("oblique")) return "oblique";
  if (normalized.includes("italic")) return "italic";
  return "normal";
}

function colorToCss(color: RgbaColor): { color: string; opacity: number } {
  const r = Math.round(clamp01(color.r) * 255);
  const g = Math.round(clamp01(color.g) * 255);
  const b = Math.round(clamp01(color.b) * 255);
  return {
    color: `#${hex(r)}${hex(g)}${hex(b)}`,
    opacity: clamp01(color.a),
  };
}

function nextDefId(context: SvgContext, prefix: string): string {
  context.sequence += 1;
  return `w2ui-${prefix}-${context.sequence}`;
}

function opacityAttr(opacity: number): string {
  return opacity < 1 ? ` opacity="${num(opacity)}"` : "";
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}
