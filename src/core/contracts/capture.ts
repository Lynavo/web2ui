/**
 * capture — High-fidelity capture contract.
 *
 * This contract carries the full visual state of a rendered document:
 * real colors, gradients, corner radii, shadows, borders, images, fonts,
 * text segments, and layout hints. It is produced by the renderer boundary
 * (packages/renderer) from a real browser and consumed by the conversion
 * engine (packages/conversion) to build render-plan documents.
 *
 * Design rules:
 * - Everything is plain JSON (structured-clone safe) so it can cross
 *   process/plugin boundaries without loss.
 * - All geometry uses absolute page CSS pixels with origin at the top-left
 *   of the captured document.
 * - Colors are always resolved sRGB with alpha in [0,1]; no symbolic refs.
 */

export const CAPTURE_CONTRACT_VERSION = "capture" as const;

export type CaptureContractVersion = typeof CAPTURE_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface RgbaColor {
  /** 0..1 */
  r: number;
  /** 0..1 */
  g: number;
  /** 0..1 */
  b: number;
  /** 0..1 */
  a: number;
}

export interface PageRect {
  /** Absolute page CSS px from document top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Paints (backgrounds / fills)
// ---------------------------------------------------------------------------

export interface SolidPaint {
  type: "solid";
  color: RgbaColor;
}

export interface GradientStop {
  /** 0..1 position along the gradient axis. */
  position: number;
  color: RgbaColor;
}

export interface LinearGradientPaint {
  type: "linear-gradient";
  /** CSS angle in degrees (0 = to top, 90 = to right), already resolved. */
  angleDegrees: number;
  stops: GradientStop[];
}

export interface RadialGradientPaint {
  type: "radial-gradient";
  /**
   * Center as fraction of the box. CSS allows centers outside the box
   * (e.g. `at 50% 120%`), so values may fall outside 0..1 — that is a
   * measured fact, not an error.
   */
  centerX: number;
  centerY: number;
  /** Radii as fraction of box width/height. */
  radiusX: number;
  radiusY: number;
  stops: GradientStop[];
}

export interface ConicGradientPaint {
  type: "conic-gradient";
  centerX: number;
  centerY: number;
  angleDegrees: number;
  stops: GradientStop[];
}

export type ImagePaintScaleMode = "fill" | "fit" | "crop" | "tile";

export interface ImagePaint {
  type: "image";
  /** Reference into CaptureDocument.assets. */
  assetId: string;
  scaleMode: ImagePaintScaleMode;
  /** Optional object-position style offsets as fractions (0..1). */
  positionX?: number;
  positionY?: number;
  /** Natural size of the referenced image if known. */
  naturalWidth?: number;
  naturalHeight?: number;
  /**
   * Measured background-repeat axes. Only meaningful for background image
   * paints; scaleMode "tile" covers repeat-both, this preserves single-axis
   * repeat facts (repeat-x / repeat-y) that "tile" cannot express.
   */
  repeat?: "no-repeat" | "repeat-x" | "repeat-y" | "repeat";
  /**
   * Measured CSS background-position for each axis. Percentages are stored as
   * fractions but deliberately not clamped because CSS permits positions
   * outside the painted box.
   */
  backgroundPosition?: {
    x: { percentage?: number; offsetPx?: number };
    y: { percentage?: number; offsetPx?: number };
  };
  /**
   * Measured explicit background-size in px (not cover/contain/auto). The
   * legacy name applies to both tiled and non-repeating backgrounds.
   */
  tileSizePx?: { width?: number; height?: number };
}

export type Paint =
  | SolidPaint
  | LinearGradientPaint
  | RadialGradientPaint
  | ConicGradientPaint
  | ImagePaint;

// ---------------------------------------------------------------------------
// Borders, radii, shadows
// ---------------------------------------------------------------------------

export interface BorderSide {
  widthPx: number;
  style: "solid" | "dashed" | "dotted" | "double" | "none";
  color: RgbaColor;
}

export interface Borders {
  top?: BorderSide;
  right?: BorderSide;
  bottom?: BorderSide;
  left?: BorderSide;
  /** True when all four sides are present and identical. */
  uniform: boolean;
}

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface Shadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  spreadRadius: number;
  color: RgbaColor;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export type TextAlign = "left" | "right" | "center" | "justify";

export type TextDecorationLine = "none" | "underline" | "line-through";

export interface TextStyle {
  /** First family in the computed CSS font-family stack, e.g. "Inter". */
  fontFamily: string;
  /** Raw font-family fallback stack for diagnostics. */
  fontFamilyStack: string;
  /**
   * Browser-selected family at capture time when it differs from
   * `fontFamily` (for example, a generic fallback after a webfont failed).
   * Optional for backward compatibility with captures made before this fact
   * was measured.
   */
  renderedFontFamily?: string;
  fontSizePx: number;
  fontWeight: number;
  italic: boolean;
  /** Resolved line-height in px. */
  lineHeightPx: number;
  /** Resolved letter-spacing in px (0 for normal). */
  letterSpacingPx: number;
  color: RgbaColor;
  textAlign: TextAlign;
  textDecoration: TextDecorationLine;
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
}

/**
 * A run of text with a single resolved style. Inline style changes
 * (e.g. <b>, <span style>) produce multiple segments under one text node.
 */
export interface TextSegment {
  text: string;
  style: TextStyle;
}

/**
 * A measured line box from the browser's own line breaking (Range API line
 * enumeration). This is the ground truth for text wrapping: consumers must
 * reproduce these lines instead of re-deriving breaks from character widths.
 */
export interface TextLineBox {
  /** Text content of this line (post-transform, as rendered). */
  text: string;
  /** Line box rect in page coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Layout hints (for Figma Auto Layout reconstruction)
// ---------------------------------------------------------------------------

export interface FlexLayoutHint {
  display: "flex" | "inline-flex";
  direction: "row" | "row-reverse" | "column" | "column-reverse";
  justifyContent: string;
  alignItems: string;
  gapRowPx: number;
  gapColumnPx: number;
  flexWrap: "nowrap" | "wrap" | "wrap-reverse";
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type CaptureNodeType = "element" | "text" | "image" | "svg";

export interface AncestorPaintOrderFact {
  /** Captured ancestor whose direct paint band this node participates in. */
  ancestorId: string;
  /** Browser-extractor order within that ancestor's flattened paint band. */
  order: number;
}

export interface CaptureNodeBase {
  /** Stable id unique within the document, e.g. "n_000042". */
  id: string;
  type: CaptureNodeType;
  /** Lowercased tag name, e.g. "div", "img", "#text". */
  tag: string;
  /** Human-friendly layer name suggestion (class/id/tag derived). */
  name: string;
  bounds: PageRect;
  /** Effective opacity of this element itself (not multiplied by ancestors). */
  opacity: number;
  /** True when overflow is hidden/clip on both axes (maps to clipsContent). */
  clipsContent: boolean;
  /** CSS z-index if positioned; used to keep paint order. */
  zIndex?: number;
  /**
   * Browser-extractor paint rank among this node's captured siblings. Lower
   * values paint first. Optional for backward compatibility; consumers must
   * prefer this measured fact and only use legacy CSS reconstruction when it
   * is absent from an older capture.
   */
  paintOrder?: number;
  /**
   * Browser-extractor paint ranks after flattening positive-z descendants
   * through ancestors that do not establish a stacking context. Conversion
   * uses the entry matching its current parent when it must split an otherwise
   * atomic Figma frame. Optional for older captures.
   */
  ancestorPaintOrders?: AncestorPaintOrderFact[];
  /** CSS order-modified document order for flex/grid items when non-zero. */
  layoutOrder?: number;
  /** Browser top-layer membership (`dialog:modal` / open popover). */
  topLayer?: true;
  /**
   * True when CSS position is not static. Positioned elements with z-index
   * auto paint above in-flow siblings (CSS2.1 Appendix E step 8 vs 4), so
   * paint-order sorting needs this even without an explicit z-index.
   */
  positioned?: boolean;
  /** 2D rotation in degrees extracted from transform matrix, if any. */
  rotationDegrees?: number;
  /**
   * Untransformed layout rect (before CSS transforms) when the element is
   * rotated/scaled. `bounds` is the transformed AABB; consumers that need the
   * true box (e.g. to apply rotation around the correct origin) must use this
   * instead of reverse-engineering it from the AABB.
   */
  layoutBounds?: PageRect;
  /** CSS mix-blend-mode when not "normal", e.g. "hard-light". */
  mixBlendMode?: string;
  /**
   * True when this element creates a CSS stacking context (measured from
   * computed style: transform, opacity<1, filter, isolation, will-change,
   * etc.). Paint-order fact — consumers must not infer it from class names.
   */
  createsStackingContext?: boolean;
  /**
   * Per-axis overflow clipping facts. `clipsContent` stays true only when
   * both axes clip; this preserves single-axis clips (overflow-x/y) that
   * `clipsContent` cannot express.
   */
  clipAxes?: { x: boolean; y: boolean };
  /**
   * Browser-measured page-coordinate clip rectangle for a supported CSS
   * `clip-path` (currently rectangular inset paths). It may extend beyond
   * `bounds` when negative insets intentionally preserve horizontal bleed.
   */
  clipBounds?: PageRect;
  /** Set when this node was synthesized from a CSS pseudo-element. */
  pseudo?: "before" | "after" | "marker";
  /**
   * Animation facts at capture time. "running" means CSS animation/transition
   * was active on this element when captured — its computed styles are a
   * mid-animation sample, not the resting design state.
   */
  animationState?: "running" | "paused";
}

export interface CaptureElementNode extends CaptureNodeBase {
  type: "element";
  fills: Paint[];
  borders?: Borders;
  cornerRadii?: CornerRadii;
  shadows?: Shadow[];
  /** CSS filter blur radius in px (blurs the element itself). */
  blurPx?: number;
  /** CSS backdrop-filter blur radius in px (frosted glass behind element). */
  backdropBlurPx?: number;
  layout?: FlexLayoutHint;
  padding?: Padding;
  /**
   * Browser-measured per-line fragment rects (from el.getClientRects()) for
   * painted inline elements that wrap across lines. `bounds` is the spanning
   * AABB and MUST NOT be used to paint the background of such elements —
   * consumers must paint one box per fragment and honor the separately
   * captured box-decoration-break fact. Only present when there are 2+
   * fragments.
   */
  fragmentRects?: PageRect[];
  /** Browser inline progression used to map slice backgrounds across fragments. */
  fragmentInlineDirection?: "ltr" | "rtl";
  /** Computed box-decoration-break fact for wrapped inline paint. */
  boxDecorationBreak?: "slice" | "clone";
  children: CaptureNode[];
}

export interface CaptureTextNode extends CaptureNodeBase {
  type: "text";
  /** Concatenation of all segment texts. */
  text: string;
  segments: TextSegment[];
  /** Style of the dominant (first/longest) segment for quick access. */
  style: TextStyle;
  /** CSS text-shadow layers (never inset, spread always 0). */
  shadows?: Shadow[];
  /**
   * Transparent browser-rendered pixels for an authored webfont. Consumers
   * keep editable text when the requested family loads and use this asset
   * only after a target-runtime font load failure. Optional for backward
   * compatibility and deliberately lower priority than page imagery.
   */
  fontFallbackAssetId?: string;
  /** Browser pixels prove that the loaded authored face delegated a glyph. */
  fontFallbackRequired?: true;
  /**
   * Browser-measured line boxes (ground truth for wrapping). When present,
   * consumers MUST use these instead of estimating breaks from font metrics.
   */
  measuredLines?: TextLineBox[];
  /** Resolved CSS direction. Default "ltr" when absent. */
  direction?: "ltr" | "rtl";
  /** Resolved CSS writing-mode when not horizontal-tb. */
  writingMode?: "vertical-rl" | "vertical-lr" | "sideways-rl" | "sideways-lr";
  /**
   * Resolved CSS text-orientation when it is "upright" under a vertical
   * writing mode. Upright glyphs (CJK columns) cannot be expressed as a
   * rotated horizontal text node — consumers must NOT apply the 90° rotation
   * model and should degrade with a warning instead.
   */
  textOrientation?: "upright";
  /**
   * Fill/clip facts for background-clip:text. When set, the text is painted
   * with the referenced element fills (gradient/image), not style.color.
   */
  fillClip?: {
    /** Paints to apply to the glyphs (from the clipping element). */
    fills: Paint[];
  };
  /** True when CSS white-space preserves newlines (pre / pre-wrap / pre-line). */
  preservesNewlines?: boolean;
}

export interface RasterFrameMeasurement {
  /** Fraction of sampled pixels whose recovered alpha is nonzero. */
  alphaCoverage: number;
  /** Fraction of sampled pixels that differ materially from the backdrop. */
  changedPixelFraction: number;
  /** Fraction of the frame covered by the contribution bounding box. */
  contributionAreaFraction: number;
  /** Tight contribution bounds in node-local CSS pixels, when measurable. */
  contributionBounds?: PageRect;
}

export interface RasterCaptureState {
  status: "captured" | "static-fallback" | "unavailable";
  sampleCount: number;
  selectedSampleIndex?: number;
  measurement?: RasterFrameMeasurement;
}

export interface CaptureImageNode extends CaptureNodeBase {
  type: "image";
  assetId?: string;
  /** Set when the asset failed to resolve; consumer must emit a placeholder. */
  assetMissing?: boolean;
  /**
   * Set when the source rendered but produced unusable content (e.g. a WebGL
   * scene captured as untextured white meshes on a GPU-less host). The
   * consumer must emit an explicit labeled placeholder, never the broken
   * pixels.
   */
  renderFallback?: boolean;
  /** Human-readable label for the fallback placeholder (accessible name). */
  fallbackLabel?: string;
  /** Browser-measured quality state for dynamic/local raster fallbacks. */
  rasterCapture?: RasterCaptureState;
  scaleMode: ImagePaintScaleMode;
  cornerRadii?: CornerRadii;
  borders?: Borders;
  shadows?: Shadow[];
  naturalWidth?: number;
  naturalHeight?: number;
  altText?: string;
}

export interface CaptureSvgNode extends CaptureNodeBase {
  type: "svg";
  /** Reference into assets: serialized (sanitized) SVG markup or raster. */
  assetId?: string;
  assetMissing?: boolean;
}

export type CaptureNode =
  | CaptureElementNode
  | CaptureTextNode
  | CaptureImageNode
  | CaptureSvgNode;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type CaptureAssetKind = "raster-image" | "svg-image" | "svg-inline";

export interface CaptureAssetBase {
  assetId: string;
  kind: CaptureAssetKind;
  mediaType: string;
  naturalWidth?: number;
  naturalHeight?: number;
  /** Bytes of the decoded payload for quota accounting. */
  byteSize: number;
  /** Original URL is redacted by default; keep a safe label only. */
  safeSourceLabel?: string;
}

export interface CaptureInlineAsset extends CaptureAssetBase {
  /**
   * Data URI (base64) or raw SVG markup for svg-inline.
   * Small assets may stay inline so capture producers do not have to split
   * every image into multipart upload fields.
   */
  data: string;
}

export type CaptureAsset = CaptureInlineAsset;

export interface CaptureFont {
  family: string;
  weightsUsed: number[];
  italicUsed: boolean;
  /** Whether the renderer confirmed the font actually loaded. */
  loaded: boolean;
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export const CAPTURE_WARNING_CODES = [
  "asset_fetch_failed",
  "asset_too_large",
  "font_not_loaded",
  "unsupported_paint",
  "unsupported_transform",
  "unsupported_filter",
  "node_limit_truncated",
  "lazy_content_incomplete",
  "cross_origin_frame_skipped",
  "video_replaced_with_poster",
  "canvas_rasterized",
  "cookie_consent_hidden",
  "pseudo_unmeasurable",
  "marker_image_skipped",
  "marker_type_skipped",
  /** Element was mid CSS animation/transition at capture — styles are a sample. */
  "animation_mid_state",
  /** A bounded local dynamic-frame fallback could not provide usable pixels. */
  "dynamic_frame_unavailable",
  /** Vertical writing-mode text rendered horizontally (Figma has no vertical text). */
  "vertical_text_unsupported",
] as const;

export type CaptureWarningCode = (typeof CAPTURE_WARNING_CODES)[number];

export function isCaptureWarningCode(value: unknown): value is CaptureWarningCode {
  return typeof value === "string" && (CAPTURE_WARNING_CODES as readonly string[]).includes(value);
}

export interface CaptureWarning {
  code: CaptureWarningCode;
  /** Node id the warning applies to, when node-scoped. */
  nodeId?: string;
  count: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface CaptureViewport {
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
}

export interface CaptureEnvironment {
  requestedViewports: {
    id: string;
    label: string;
    widthPx: number | null;
    source: "browser" | "preset";
  }[];
  requestedThemes: {
    id: "browser" | "light" | "dark";
    label: string;
    source: "browser" | "forced";
  }[];
  resolvedViewport: CaptureViewport;
  resolvedColorScheme: string | null;
}

export interface CaptureDocument {
  schemaVersion: CaptureContractVersion;
  captureId: `cap_${string}`;
  sourceType: "chrome_capture";
  capturedAt: string;
  /** Redacted-safe label of the source (hostname or archive label). */
  safeSourceLabel: string;
  viewport: CaptureViewport;
  /** Full document size after scroll stabilization. */
  page: {
    widthPx: number;
    heightPx: number;
    /** Whether full-page (scrolled) capture completed vs viewport-only. */
    fullPage: boolean;
  };
  /** Page background (html/body resolved). */
  pageBackground: RgbaColor;
  /** Non-rendering capture environment metadata for diagnostics and handoff UI. */
  environment?: CaptureEnvironment;
  /**
   * Versioned opt-in for extractor-measured cross-ancestor paint bands.
   * Absent documents predate `ancestorPaintOrders` and retain legacy
   * conversion reconstruction.
   */
  paintOrderVersion?: 1;
  root: CaptureElementNode;
  assets: CaptureAsset[];
  fonts: CaptureFont[];
  warnings: CaptureWarning[];
  stats: {
    nodeCount: number;
    textNodeCount: number;
    imageNodeCount: number;
    assetByteTotal: number;
    captureDurationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Guards / helpers
// ---------------------------------------------------------------------------

export function isCaptureDocument(value: unknown): value is CaptureDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CaptureDocument>;
  return (
    candidate.schemaVersion === CAPTURE_CONTRACT_VERSION &&
    typeof candidate.captureId === "string" &&
    candidate.captureId.startsWith("cap_") &&
    candidate.sourceType === "chrome_capture" &&
    typeof candidate.capturedAt === "string" &&
    typeof candidate.safeSourceLabel === "string" &&
    isCaptureViewport(candidate.viewport) &&
    isCapturePage(candidate.page) &&
    isRgbaColor(candidate.pageBackground) &&
    (candidate.environment === undefined || isCaptureEnvironment(candidate.environment)) &&
    (candidate.paintOrderVersion === undefined || candidate.paintOrderVersion === 1) &&
    isCaptureElementNode(candidate.root, 0) &&
    Array.isArray(candidate.assets) &&
    candidate.assets.every(isCaptureAsset) &&
    Array.isArray(candidate.fonts) &&
    candidate.fonts.every(isCaptureFont) &&
    Array.isArray(candidate.warnings) &&
    candidate.warnings.every(isCaptureWarning) &&
    isCaptureStats(candidate.stats)
  );
}

function isCaptureEnvironment(value: unknown): value is CaptureEnvironment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureEnvironment>;
  return (
    Array.isArray(candidate.requestedViewports) &&
    candidate.requestedViewports.every((viewport) => {
      if (typeof viewport !== "object" || viewport === null) return false;
      const item = viewport as CaptureEnvironment["requestedViewports"][number];
      return (
        isNonEmptyString(item.id) &&
        typeof item.label === "string" &&
        (item.widthPx === null || isFinitePositiveNumber(item.widthPx)) &&
        (item.source === "browser" || item.source === "preset")
      );
    }) &&
    Array.isArray(candidate.requestedThemes) &&
    candidate.requestedThemes.every((theme) => {
      if (typeof theme !== "object" || theme === null) return false;
      const item = theme as CaptureEnvironment["requestedThemes"][number];
      return (
        (item.id === "browser" || item.id === "light" || item.id === "dark") &&
        typeof item.label === "string" &&
        (item.source === "browser" || item.source === "forced")
      );
    }) &&
    isCaptureViewport(candidate.resolvedViewport) &&
    (candidate.resolvedColorScheme === null ||
      typeof candidate.resolvedColorScheme === "string")
  );
}

function isCaptureViewport(value: unknown): value is CaptureViewport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureViewport>;
  return (
    isFinitePositiveNumber(candidate.widthPx) &&
    isFinitePositiveNumber(candidate.heightPx) &&
    isFinitePositiveNumber(candidate.deviceScaleFactor)
  );
}

function isCapturePage(value: unknown): value is CaptureDocument["page"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureDocument["page"]>;
  return (
    isFinitePositiveNumber(candidate.widthPx) &&
    isFinitePositiveNumber(candidate.heightPx) &&
    typeof candidate.fullPage === "boolean"
  );
}

function isCaptureElementNode(value: unknown, depth: number): value is CaptureElementNode {
  if (!isCaptureNodeBase(value, "element") || depth > 500) return false;
  const candidate = value as Partial<CaptureElementNode>;
  return (
    Array.isArray(candidate.fills) &&
    candidate.fills.every(isPaint) &&
    (candidate.borders === undefined || isBorders(candidate.borders)) &&
    (candidate.cornerRadii === undefined || isCornerRadii(candidate.cornerRadii)) &&
    (candidate.shadows === undefined ||
      (Array.isArray(candidate.shadows) && candidate.shadows.every(isShadow))) &&
    (candidate.blurPx === undefined || isFiniteNonNegativeNumber(candidate.blurPx)) &&
    (candidate.backdropBlurPx === undefined || isFiniteNonNegativeNumber(candidate.backdropBlurPx)) &&
    (candidate.layout === undefined || isFlexLayoutHint(candidate.layout)) &&
    (candidate.padding === undefined || isPadding(candidate.padding)) &&
    (candidate.fragmentRects === undefined ||
      (Array.isArray(candidate.fragmentRects) && candidate.fragmentRects.every(isPageRect))) &&
    (candidate.fragmentInlineDirection === undefined ||
      candidate.fragmentInlineDirection === "ltr" ||
      candidate.fragmentInlineDirection === "rtl") &&
    (candidate.boxDecorationBreak === undefined ||
      candidate.boxDecorationBreak === "slice" ||
      candidate.boxDecorationBreak === "clone") &&
    Array.isArray(candidate.children) &&
    candidate.children.every((child) => isCaptureNode(child, depth + 1))
  );
}

function isCaptureNode(value: unknown, depth: number): value is CaptureNode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown };
  if (candidate.type === "element") return isCaptureElementNode(value, depth);
  if (candidate.type === "text") return isCaptureTextNode(value);
  if (candidate.type === "image") return isCaptureImageNode(value);
  if (candidate.type === "svg") return isCaptureSvgNode(value);
  return false;
}

function isCaptureNodeBase(
  value: unknown,
  type: CaptureNodeType,
): value is CaptureNodeBase {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureNodeBase>;
  return (
    candidate.type === type &&
    isNonEmptyString(candidate.id) &&
    typeof candidate.tag === "string" &&
    typeof candidate.name === "string" &&
    isPageRect(candidate.bounds) &&
    isOpacity(candidate.opacity) &&
    typeof candidate.clipsContent === "boolean" &&
    (candidate.zIndex === undefined || isFiniteNumber(candidate.zIndex)) &&
    (candidate.paintOrder === undefined || isFiniteNumber(candidate.paintOrder)) &&
    (candidate.ancestorPaintOrders === undefined ||
      (Array.isArray(candidate.ancestorPaintOrders) &&
        candidate.ancestorPaintOrders.every(isAncestorPaintOrderFact))) &&
    (candidate.layoutOrder === undefined || isFiniteNumber(candidate.layoutOrder)) &&
    (candidate.topLayer === undefined || candidate.topLayer === true) &&
    (candidate.positioned === undefined || typeof candidate.positioned === "boolean") &&
    (candidate.rotationDegrees === undefined || isFiniteNumber(candidate.rotationDegrees)) &&
    (candidate.layoutBounds === undefined || isPageRect(candidate.layoutBounds)) &&
    (candidate.createsStackingContext === undefined ||
      typeof candidate.createsStackingContext === "boolean") &&
    (candidate.clipAxes === undefined || isClipAxes(candidate.clipAxes)) &&
    (candidate.clipBounds === undefined || isPageRect(candidate.clipBounds)) &&
    (candidate.mixBlendMode === undefined || typeof candidate.mixBlendMode === "string") &&
    (candidate.pseudo === undefined ||
      candidate.pseudo === "before" ||
      candidate.pseudo === "after" ||
      candidate.pseudo === "marker") &&
    (candidate.animationState === undefined ||
      candidate.animationState === "running" ||
      candidate.animationState === "paused")
  );
}

function isAncestorPaintOrderFact(value: unknown): value is AncestorPaintOrderFact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AncestorPaintOrderFact>;
  return isNonEmptyString(candidate.ancestorId) && isFiniteNumber(candidate.order);
}

function isClipAxes(value: unknown): value is NonNullable<CaptureNodeBase["clipAxes"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === "boolean" && typeof candidate.y === "boolean";
}

function isCaptureTextNode(value: unknown): value is CaptureTextNode {
  if (!isCaptureNodeBase(value, "text")) return false;
  const candidate = value as Partial<CaptureTextNode>;
  return (
    typeof candidate.text === "string" &&
    Array.isArray(candidate.segments) &&
    candidate.segments.length > 0 &&
    candidate.segments.every(isTextSegment) &&
    isTextStyle(candidate.style) &&
    (candidate.fontFallbackAssetId === undefined ||
      isNonEmptyString(candidate.fontFallbackAssetId)) &&
    (candidate.fontFallbackRequired === undefined || candidate.fontFallbackRequired === true) &&
    (candidate.shadows === undefined ||
      (Array.isArray(candidate.shadows) && candidate.shadows.every(isShadow))) &&
    (candidate.measuredLines === undefined ||
      (Array.isArray(candidate.measuredLines) && candidate.measuredLines.every(isTextLineBox))) &&
    (candidate.direction === undefined ||
      candidate.direction === "ltr" ||
      candidate.direction === "rtl") &&
    (candidate.writingMode === undefined ||
      candidate.writingMode === "vertical-rl" ||
      candidate.writingMode === "vertical-lr" ||
      candidate.writingMode === "sideways-rl" ||
      candidate.writingMode === "sideways-lr") &&
    (candidate.textOrientation === undefined || candidate.textOrientation === "upright") &&
    (candidate.fillClip === undefined || isTextFillClip(candidate.fillClip)) &&
    (candidate.preservesNewlines === undefined || typeof candidate.preservesNewlines === "boolean")
  );
}

function isTextLineBox(value: unknown): value is TextLineBox {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TextLineBox>;
  return (
    typeof candidate.text === "string" &&
    isFiniteNumber(candidate.x) &&
    isFiniteNumber(candidate.y) &&
    isFiniteNonNegativeNumber(candidate.width) &&
    isFiniteNonNegativeNumber(candidate.height)
  );
}

function isTextFillClip(value: unknown): value is NonNullable<CaptureTextNode["fillClip"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { fills?: unknown };
  return Array.isArray(candidate.fills) && candidate.fills.every(isPaint);
}

function isCaptureImageNode(value: unknown): value is CaptureImageNode {
  if (!isCaptureNodeBase(value, "image")) return false;
  const candidate = value as Partial<CaptureImageNode>;
  return (
    (candidate.assetId === undefined || isNonEmptyString(candidate.assetId)) &&
    (candidate.assetMissing === undefined || typeof candidate.assetMissing === "boolean") &&
    (candidate.renderFallback === undefined || typeof candidate.renderFallback === "boolean") &&
    (candidate.fallbackLabel === undefined || typeof candidate.fallbackLabel === "string") &&
    (candidate.rasterCapture === undefined || isRasterCaptureState(candidate.rasterCapture)) &&
    isImagePaintScaleMode(candidate.scaleMode) &&
    (candidate.cornerRadii === undefined || isCornerRadii(candidate.cornerRadii)) &&
    (candidate.borders === undefined || isBorders(candidate.borders)) &&
    (candidate.shadows === undefined ||
      (Array.isArray(candidate.shadows) && candidate.shadows.every(isShadow))) &&
    (candidate.naturalWidth === undefined || isFiniteNonNegativeNumber(candidate.naturalWidth)) &&
    (candidate.naturalHeight === undefined || isFiniteNonNegativeNumber(candidate.naturalHeight)) &&
    (candidate.altText === undefined || typeof candidate.altText === "string")
  );
}

function isRasterCaptureState(value: unknown): value is RasterCaptureState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RasterCaptureState>;
  const measurement = candidate.measurement as Partial<RasterFrameMeasurement> | undefined;
  return (
    (candidate.status === "captured" ||
      candidate.status === "static-fallback" ||
      candidate.status === "unavailable") &&
    isFiniteNonNegativeNumber(candidate.sampleCount) &&
    (candidate.selectedSampleIndex === undefined ||
      isFiniteNonNegativeNumber(candidate.selectedSampleIndex)) &&
    (measurement === undefined ||
      (isUnitNumber(measurement.alphaCoverage) &&
        isUnitNumber(measurement.changedPixelFraction) &&
        isUnitNumber(measurement.contributionAreaFraction) &&
        (measurement.contributionBounds === undefined ||
          isPageRect(measurement.contributionBounds))))
  );
}

function isCaptureSvgNode(value: unknown): value is CaptureSvgNode {
  if (!isCaptureNodeBase(value, "svg")) return false;
  const candidate = value as Partial<CaptureSvgNode>;
  return (
    (candidate.assetId === undefined || isNonEmptyString(candidate.assetId)) &&
    (candidate.assetMissing === undefined || typeof candidate.assetMissing === "boolean")
  );
}

function isPageRect(value: unknown): value is PageRect {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PageRect>;
  return (
    isFiniteNumber(candidate.x) &&
    isFiniteNumber(candidate.y) &&
    isFiniteNonNegativeNumber(candidate.width) &&
    isFiniteNonNegativeNumber(candidate.height)
  );
}

function isRgbaColor(value: unknown): value is RgbaColor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RgbaColor>;
  return (
    isUnitNumber(candidate.r) &&
    isUnitNumber(candidate.g) &&
    isUnitNumber(candidate.b) &&
    isUnitNumber(candidate.a)
  );
}

function isPaint(value: unknown): value is Paint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Paint>;
  if (candidate.type === "solid") {
    return isRgbaColor((candidate as Partial<SolidPaint>).color);
  }
  if (candidate.type === "linear-gradient") {
    const paint = candidate as Partial<LinearGradientPaint>;
    return isFiniteNumber(paint.angleDegrees) && isGradientStops(paint.stops);
  }
  if (candidate.type === "radial-gradient") {
    const paint = candidate as Partial<RadialGradientPaint>;
    // The center may lie outside the box (a CSS fact such as `at 50% 120%`);
    // only finite values are required.
    return (
      isFiniteNumber(paint.centerX) &&
      isFiniteNumber(paint.centerY) &&
      isFiniteNonNegativeNumber(paint.radiusX) &&
      isFiniteNonNegativeNumber(paint.radiusY) &&
      isGradientStops(paint.stops)
    );
  }
  if (candidate.type === "conic-gradient") {
    const paint = candidate as Partial<ConicGradientPaint>;
    return (
      isFiniteNumber(paint.centerX) &&
      isFiniteNumber(paint.centerY) &&
      isFiniteNumber(paint.angleDegrees) &&
      isGradientStops(paint.stops)
    );
  }
  if (candidate.type === "image") {
    const paint = candidate as Partial<ImagePaint>;
    return (
      isNonEmptyString(paint.assetId) &&
      isImagePaintScaleMode(paint.scaleMode) &&
      (paint.positionX === undefined || isFiniteNumber(paint.positionX)) &&
      (paint.positionY === undefined || isFiniteNumber(paint.positionY)) &&
      (paint.naturalWidth === undefined || isFiniteNonNegativeNumber(paint.naturalWidth)) &&
      (paint.naturalHeight === undefined || isFiniteNonNegativeNumber(paint.naturalHeight)) &&
      (paint.repeat === undefined ||
        paint.repeat === "no-repeat" ||
        paint.repeat === "repeat-x" ||
        paint.repeat === "repeat-y" ||
        paint.repeat === "repeat") &&
      (paint.backgroundPosition === undefined ||
        isBackgroundPosition(paint.backgroundPosition)) &&
      (paint.tileSizePx === undefined || isImageTileSize(paint.tileSizePx))
    );
  }
  return false;
}

function isImageTileSize(value: unknown): value is NonNullable<ImagePaint["tileSizePx"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { width?: unknown; height?: unknown };
  return (
    (candidate.width !== undefined || candidate.height !== undefined) &&
    (candidate.width === undefined || isFiniteNonNegativeNumber(candidate.width)) &&
    (candidate.height === undefined || isFiniteNonNegativeNumber(candidate.height))
  );
}

function isGradientStops(value: unknown): value is GradientStop[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((stop) => {
      if (typeof stop !== "object" || stop === null) return false;
      const candidate = stop as Partial<GradientStop>;
      return isUnitNumber(candidate.position) && isRgbaColor(candidate.color);
    })
  );
}

function isBackgroundPosition(
  value: unknown,
): value is NonNullable<ImagePaint["backgroundPosition"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    x?: unknown;
    y?: unknown;
  };
  return isBackgroundPositionAxis(candidate.x) && isBackgroundPositionAxis(candidate.y);
}

function isBackgroundPositionAxis(
  value: unknown,
): value is NonNullable<ImagePaint["backgroundPosition"]>["x"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { percentage?: unknown; offsetPx?: unknown };
  return (
    (candidate.percentage !== undefined || candidate.offsetPx !== undefined) &&
    (candidate.percentage === undefined || isFiniteNumber(candidate.percentage)) &&
    (candidate.offsetPx === undefined || isFiniteNumber(candidate.offsetPx))
  );
}

function isBorders(value: unknown): value is Borders {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Borders>;
  return (
    typeof candidate.uniform === "boolean" &&
    (candidate.top === undefined || isBorderSide(candidate.top)) &&
    (candidate.right === undefined || isBorderSide(candidate.right)) &&
    (candidate.bottom === undefined || isBorderSide(candidate.bottom)) &&
    (candidate.left === undefined || isBorderSide(candidate.left))
  );
}

function isBorderSide(value: unknown): value is BorderSide {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BorderSide>;
  return (
    isFiniteNonNegativeNumber(candidate.widthPx) &&
    ["solid", "dashed", "dotted", "double", "none"].includes(candidate.style ?? "") &&
    isRgbaColor(candidate.color)
  );
}

function isCornerRadii(value: unknown): value is CornerRadii {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CornerRadii>;
  return (
    isFiniteNonNegativeNumber(candidate.topLeft) &&
    isFiniteNonNegativeNumber(candidate.topRight) &&
    isFiniteNonNegativeNumber(candidate.bottomRight) &&
    isFiniteNonNegativeNumber(candidate.bottomLeft)
  );
}

function isShadow(value: unknown): value is Shadow {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Shadow>;
  return (
    typeof candidate.inset === "boolean" &&
    isFiniteNumber(candidate.offsetX) &&
    isFiniteNumber(candidate.offsetY) &&
    isFiniteNonNegativeNumber(candidate.blurRadius) &&
    isFiniteNumber(candidate.spreadRadius) &&
    isRgbaColor(candidate.color)
  );
}

function isTextStyle(value: unknown): value is TextStyle {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TextStyle>;
  return (
    typeof candidate.fontFamily === "string" &&
    typeof candidate.fontFamilyStack === "string" &&
    (candidate.renderedFontFamily === undefined ||
      typeof candidate.renderedFontFamily === "string") &&
    isFinitePositiveNumber(candidate.fontSizePx) &&
    isFiniteNonNegativeNumber(candidate.fontWeight) &&
    typeof candidate.italic === "boolean" &&
    isFinitePositiveNumber(candidate.lineHeightPx) &&
    isFiniteNumber(candidate.letterSpacingPx) &&
    isRgbaColor(candidate.color) &&
    ["left", "right", "center", "justify"].includes(candidate.textAlign ?? "") &&
    ["none", "underline", "line-through"].includes(candidate.textDecoration ?? "") &&
    ["none", "uppercase", "lowercase", "capitalize"].includes(candidate.textTransform ?? "")
  );
}

function isTextSegment(value: unknown): value is TextSegment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TextSegment>;
  return typeof candidate.text === "string" && isTextStyle(candidate.style);
}

function isFlexLayoutHint(value: unknown): value is FlexLayoutHint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FlexLayoutHint>;
  return (
    (candidate.display === "flex" || candidate.display === "inline-flex") &&
    ["row", "row-reverse", "column", "column-reverse"].includes(candidate.direction ?? "") &&
    typeof candidate.justifyContent === "string" &&
    typeof candidate.alignItems === "string" &&
    isFiniteNonNegativeNumber(candidate.gapRowPx) &&
    isFiniteNonNegativeNumber(candidate.gapColumnPx) &&
    ["nowrap", "wrap", "wrap-reverse"].includes(candidate.flexWrap ?? "")
  );
}

function isPadding(value: unknown): value is Padding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Padding>;
  return (
    isFiniteNonNegativeNumber(candidate.top) &&
    isFiniteNonNegativeNumber(candidate.right) &&
    isFiniteNonNegativeNumber(candidate.bottom) &&
    isFiniteNonNegativeNumber(candidate.left)
  );
}

function isCaptureStats(value: unknown): value is CaptureDocument["stats"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureDocument["stats"]>;
  return (
    isFiniteNonNegativeNumber(candidate.nodeCount) &&
    isFiniteNonNegativeNumber(candidate.textNodeCount) &&
    isFiniteNonNegativeNumber(candidate.imageNodeCount) &&
    isFiniteNonNegativeNumber(candidate.assetByteTotal) &&
    isFiniteNonNegativeNumber(candidate.captureDurationMs)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isOpacity(value: unknown): value is number {
  return isUnitNumber(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isImagePaintScaleMode(value: unknown): value is ImagePaintScaleMode {
  return value === "fill" || value === "fit" || value === "crop" || value === "tile";
}

function isCaptureAsset(value: unknown): value is CaptureAsset {
  if (typeof value !== "object" || value === null) return false;
  const asset = value as Partial<CaptureAsset>;
  if (
    typeof asset.assetId !== "string" ||
    !["raster-image", "svg-image", "svg-inline"].includes(asset.kind ?? "") ||
    typeof asset.mediaType !== "string" ||
    typeof asset.byteSize !== "number" ||
    !Number.isFinite(asset.byteSize) ||
    asset.byteSize < 0 ||
    (asset.naturalWidth !== undefined && !isFiniteNonNegativeNumber(asset.naturalWidth)) ||
    (asset.naturalHeight !== undefined && !isFiniteNonNegativeNumber(asset.naturalHeight)) ||
    (asset.safeSourceLabel !== undefined && typeof asset.safeSourceLabel !== "string")
  ) {
    return false;
  }

  return typeof asset.data === "string";
}

function isCaptureFont(value: unknown): value is CaptureFont {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureFont>;
  return (
    typeof candidate.family === "string" &&
    Array.isArray(candidate.weightsUsed) &&
    candidate.weightsUsed.every(isFiniteNonNegativeNumber) &&
    typeof candidate.italicUsed === "boolean" &&
    typeof candidate.loaded === "boolean"
  );
}

function isCaptureWarning(value: unknown): value is CaptureWarning {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureWarning>;
  return (
    isCaptureWarningCode(candidate.code) &&
    (candidate.nodeId === undefined || typeof candidate.nodeId === "string") &&
    isFiniteNonNegativeNumber(candidate.count) &&
    (candidate.detail === undefined || typeof candidate.detail === "string")
  );
}

/**
 * Decode the two legal inline capture encodings: a data URL for binary assets,
 * or raw SVG markup when the captured media type is SVG.
 */
export function decodeCaptureInlineAssetData(
  data: string,
  mediaType: string,
): Uint8Array | null {
  if (!data.startsWith("data:")) {
    return normalizeMediaType(mediaType) === "image/svg+xml" && isSvgMarkup(data)
      ? new TextEncoder().encode(data)
      : null;
  }

  const commaIndex = data.indexOf(",");
  if (commaIndex < 0) return null;
  const header = data.slice(5, commaIndex).toLowerCase();
  const payload = data.slice(commaIndex + 1);
  try {
    if (header.includes(";base64")) {
      const binary = globalThis.atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/** Normalize MIME facts before comparing them across capture/worker/plugin boundaries. */
export function normalizeMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Accept XML declarations and comments before the root, but never a DTD. */
export function isSvgMarkup(input: string | Uint8Array): boolean {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let cursor = text.startsWith("\uFEFF") ? 1 : 0;

  while (cursor < text.length) {
    while (cursor < text.length && text[cursor]?.trim() === "") cursor += 1;

    if (text.slice(cursor, cursor + 5).toLowerCase() === "<?xml") {
      const declarationEnd = text.indexOf("?>", cursor + 5);
      if (declarationEnd < 0) return false;
      cursor = declarationEnd + 2;
      continue;
    }

    if (text.startsWith("<!--", cursor)) {
      const commentEnd = text.indexOf("-->", cursor + 4);
      if (commentEnd < 0) return false;
      cursor = commentEnd + 3;
      continue;
    }

    break;
  }

  if (text.slice(cursor, cursor + 4).toLowerCase() !== "<svg") return false;
  const boundary = text[cursor + 4];
  return boundary === undefined || boundary === ">" || boundary === "/" || boundary.trim() === "";
}

/**
 * Conservative SVG safety gate shared by upload, renderer and worker paths.
 * Local fragment references (`#gradient`) remain valid; executable elements,
 * DTD/entities and every external/data resource reference are rejected.
 */
export function isSafeSvgMarkup(input: string | Uint8Array): boolean {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  if (!isSvgMarkup(text)) return false;
  if (
    /<!\s*(?:doctype|entity)\b/i.test(text) ||
    /<\?xml-stylesheet\b/i.test(text) ||
    /\\/.test(text) ||
    /\bxml:base\s*=/i.test(text) ||
    /<\s*(?:[a-z_][\w.-]*:)?(?:script|style|animate|set|foreignobject|iframe|object|embed)\b/i.test(text) ||
    /<\/?\s*[a-z_][\w.-]*:[a-z_]/i.test(text) ||
    /\bxmlns:(?!xlink\b)[a-z_][\w.-]*\s*=/i.test(text) ||
    /\son[a-z][a-z0-9:_-]*\s*=/i.test(text) ||
    /@import\b/i.test(text)
  ) {
    return false;
  }

  const hrefPattern = /\b(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of text.matchAll(hrefPattern)) {
    const value = normalizeSvgReference(match[1] ?? match[2] ?? match[3] ?? "");
    if (value && !value.startsWith("#")) return false;
  }

  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  for (const match of text.matchAll(urlPattern)) {
    const value = normalizeSvgReference(match[1] ?? match[2] ?? match[3] ?? "");
    if (!value.startsWith("#")) return false;
  }
  return true;
}

function normalizeSvgReference(value: string): string {
  let normalized = value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}
