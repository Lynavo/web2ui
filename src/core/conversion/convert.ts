/**
 * capture → render-plan conversion engine.
 *
 * Pure, deterministic, side-effect free. All Figma-specific math (gradient
 * transforms, font style names, relative geometry) happens HERE so the
 * plugin stays a thin executor.
 */

import type {
  Borders,
  CaptureAsset,
  CaptureInlineAsset,
  CaptureDocument,
  CaptureElementNode,
  CaptureImageNode,
  CaptureNode,
  CaptureSvgNode,
  CaptureTextNode,
  CaptureWarning,
  CornerRadii,
  FlexLayoutHint,
  Paint,
  RgbaColor,
  Shadow,
  TextLineBox,
  TextStyle,
} from "../contracts/capture.js";
import type {
  FigmaBlendMode,
  FigmaEffect,
  FigmaGradientTransform,
  FigmaPaint,
  RenderPlanAsset,
  RenderPlanAutoLayout,
  RenderPlanFontRequest,
  RenderPlanFrameNode,
  RenderPlanNode,
  RenderPlanTextNode,
  RenderPlanTextSegment,
  RenderPlan,
} from "../contracts/render-plan.js";
import { isSafeSvgMarkup } from "../contracts/capture.js";
import { RENDER_PLAN_CONTRACT_VERSION } from "../contracts/render-plan.js";
import {
  FALLBACK_LINE_HEIGHT_RATIO,
  NEAR_SQUARE_TOLERANCE,
  SINGLE_LINE_CAPTURED_MAX_RATIO,
  SINGLE_LINE_CAPTURED_MIN_RATIO,
  SINGLE_LINE_STYLE_HEIGHT_RATIO_MAX,
} from "./thresholds.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /**
   * Emit Auto Layout hints on frames whose children fit the flex model.
   * Disabled by default: applying layoutMode in Figma re-flows children and
   * overrides captured absolute positions, which destroys pixel fidelity.
   * Enable only for editability-first exports.
   */
  emitAutoLayout?: boolean;
}

export function convertCaptureToRenderPlan(
  capture: CaptureDocument,
  options: ConvertOptions = {},
): RenderPlan {
  const startedAt = Date.now();
  const context: ConversionContext = {
    emitAutoLayout: options.emitAutoLayout ?? false,
    assetsById: new Map(capture.assets.map((asset) => [asset.assetId, asset])),
    usedAssetIds: new Set<string>(),
    fillAssetIds: new Set<string>(),
    warnings: [...capture.warnings],
    nodeSequence: 0,
    nodeCount: 0,
    textNodeCount: 0,
    fontKeys: new Map(),
    inheritedRotationDegrees: 0,
    paintOrderVersion: capture.paintOrderVersion,
  };

  const rootFrame = convertElement(capture.root, capture.root.bounds, context);
  // The root frame always spans the full page.
  rootFrame.x = 0;
  rootFrame.y = 0;
  rootFrame.width = Math.max(1, capture.page.widthPx);
  rootFrame.height = Math.max(1, capture.page.heightPx);
  rootFrame.name = capture.safeSourceLabel || "Imported page";
  // The browser viewport clips horizontal overflow (carousels, off-canvas
  // decorations) at the page edge; mirror that so oversized children don't
  // blow out the artboard in Figma.
  rootFrame.clipsContent = true;
  if (rootFrame.fills.length === 0) {
    rootFrame.fills = [solidPaint(capture.pageBackground)];
  }

  const assets = buildAssets(context);
  const fonts = buildFontRequests(context);

  return {
    schemaVersion: RENDER_PLAN_CONTRACT_VERSION,
    renderPlanId: `rp_${capture.captureId.slice(4)}`,
    sourceCaptureId: capture.captureId,
    sourceType: capture.sourceType,
    createdAt: new Date().toISOString(),
    safeSourceLabel: capture.safeSourceLabel,
    page: {
      widthPx: capture.page.widthPx,
      heightPx: capture.page.heightPx,
      background: capture.pageBackground,
    },
    root: rootFrame,
    assets,
    fonts,
    warnings: context.warnings,
    stats: {
      nodeCount: context.nodeCount,
      textNodeCount: context.textNodeCount,
      assetCount: assets.length,
      conversionDurationMs: Date.now() - startedAt,
    },
  };
}

/**
 * Browser/plugin-safe conversion for local Chrome-extension exports.
 *
 * The canonical conversion still emits asset refs back to the source capture.
 * This adapter keeps that single conversion path, then hydrates used capture
 * assets into data-URL refs so the result can be pasted without any remote
 * hydration step.
 */
export function convertCaptureToPortableRenderPlan(
  capture: CaptureDocument,
  options: ConvertOptions = {},
): RenderPlan {
  const plan = convertCaptureToRenderPlan(capture, options);
  if (plan.assets.length === 0) return plan;

  const captureAssets = new Map(capture.assets.map((asset) => [asset.assetId, asset]));
  return {
    ...plan,
    assets: plan.assets.map((asset) => {
      if (asset.ref.kind !== "capture") return asset;
      const captureAsset = captureAssets.get(asset.ref.assetId);
      if (!captureAsset) {
        throw new Error(`portable render-plan cannot hydrate missing capture asset ${asset.ref.assetId}`);
      }
      return {
        ...asset,
        ref: { kind: "url", url: captureAssetDataUrl(captureAsset) },
      };
    }),
  };
}

function captureAssetDataUrl(asset: CaptureInlineAsset): `data:${string}` {
  if (asset.data.startsWith("data:")) return asset.data as `data:${string}`;
  if (asset.mediaType === "image/svg+xml" || asset.kind === "svg-inline") {
    return `data:${asset.mediaType};utf8,${encodeURIComponent(asset.data)}`;
  }
  throw new Error(`portable render-plan cannot encode non-data capture asset ${asset.assetId}`);
}

function decodeDataUri(data: string): Uint8Array | null {
  if (!data.startsWith("data:")) return null;
  const commaIndex = data.indexOf(",");
  if (commaIndex < 0) return null;
  const header = data.slice(0, commaIndex);
  const payload = data.slice(commaIndex + 1);
  try {
    if (header.includes(";base64")) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ConversionContext {
  emitAutoLayout: boolean;
  assetsById: Map<string, CaptureDocument["assets"][number]>;
  usedAssetIds: Set<string>;
  /** Assets referenced by IMAGE fills. SVG bytes must also travel with the plan. */
  fillAssetIds: Set<string>;
  warnings: CaptureWarning[];
  nodeSequence: number;
  nodeCount: number;
  textNodeCount: number;
  /** family -> set of style names */
  fontKeys: Map<string, Set<string>>;
  /**
   * Accumulated rotation from discarded ancestors (positive is clockwise in
   * CSS). rotationDegrees is not applied to frames that contain children (see
   * convertElement), but this fact is required to derive the net reading
   * direction of vertical text. For example, an MDN BCD header using
   * vertical-rl inside a parent rotated 180 degrees reads bottom-to-top.
   * Used only for text direction derivation.
   */
  inheritedRotationDegrees: number;
  /** Fresh captures provide extractor-measured cross-ancestor paint bands. */
  paintOrderVersion: CaptureDocument["paintOrderVersion"];
}

function nextId(context: ConversionContext): string {
  context.nodeSequence += 1;
  return `rp_${String(context.nodeSequence).padStart(6, "0")}`;
}

function addWarning(context: ConversionContext, warning: CaptureWarning): void {
  context.warnings.push(warning);
}

// ---------------------------------------------------------------------------
// Node conversion
// ---------------------------------------------------------------------------

interface ParentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function renderGeometryFromBounds(
  bounds: ParentBounds,
  parentBounds: ParentBounds,
  rotationDegrees: number | undefined,
  layoutBounds?: ParentBounds,
): RenderGeometry {
  // Prefer measured facts: the extractor records the untransformed layout box
  // in layoutBounds. Reverse-solve the AABB only for legacy captures that lack
  // this field.
  const localBounds =
    rotationDegrees !== undefined && rotationDegrees !== 0
      ? (layoutBounds ?? unrotateAxisAlignedBounds(bounds, rotationDegrees))
      : bounds;
  return {
    x: round2(localBounds.x - parentBounds.x),
    y: round2(localBounds.y - parentBounds.y),
    width: Math.max(0.01, round2(localBounds.width)),
    height: Math.max(0.01, round2(localBounds.height)),
  };
}

function unrotateAxisAlignedBounds(bounds: ParentBounds, rotationDegrees: number): ParentBounds {
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  if (sin < 1e-6 || cos < 1e-6) {
    return bounds;
  }

  const det = cos * cos - sin * sin;
  let width: number;
  let height: number;
  if (Math.abs(det) < 1e-6) {
    const maxSide = Math.max(bounds.width, bounds.height, 1);
    if (Math.abs(bounds.width - bounds.height) / maxSide > NEAR_SQUARE_TOLERANCE) {
      return bounds;
    }
    width = bounds.width / (cos + sin);
    height = bounds.height / (cos + sin);
  } else {
    width = (bounds.width * cos - bounds.height * sin) / det;
    height = (bounds.height * cos - bounds.width * sin) / det;
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return bounds;
  }

  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}

function convertNode(
  node: CaptureNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode | null {
  switch (node.type) {
    case "element":
      return convertElement(node, parentBounds, context);
    case "text":
      return convertText(node, parentBounds, context);
    case "image":
      return convertImage(node, parentBounds, context);
    case "svg":
      return convertSvg(node, parentBounds, context);
    default:
      return null;
  }
}

type CaptureImagePaint = Extract<Paint, { type: "image" }>;
type BackgroundPositionAxis = NonNullable<CaptureImagePaint["backgroundPosition"]>["x"];

interface PositionedBackgroundLayer {
  paint: CaptureImagePaint;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedBackgroundSuffix {
  remainingFills: Paint[];
  layers: PositionedBackgroundLayer[];
}

function completeBackgroundPositionAxis(axis: BackgroundPositionAxis): boolean {
  if (typeof axis !== "object" || axis === null) return false;
  const hasValue = axis.percentage !== undefined || axis.offsetPx !== undefined;
  return (
    hasValue &&
    (axis.percentage === undefined || Number.isFinite(axis.percentage)) &&
    (axis.offsetPx === undefined || Number.isFinite(axis.offsetPx))
  );
}

function resolvePositionedBackgroundLayer(
  paint: Paint,
  bounds: { width: number; height: number },
  context: ConversionContext,
): PositionedBackgroundLayer | null {
  if (
    paint.type !== "image" ||
    paint.scaleMode !== "crop" ||
    paint.repeat !== "no-repeat" ||
    paint.backgroundPosition === undefined ||
    !completeBackgroundPositionAxis(paint.backgroundPosition.x) ||
    !completeBackgroundPositionAxis(paint.backgroundPosition.y)
  ) {
    return null;
  }

  const asset = context.assetsById.get(paint.assetId);
  if (!asset) return null;
  const naturalWidth = paint.naturalWidth ?? asset.naturalWidth;
  const naturalHeight = paint.naturalHeight ?? asset.naturalHeight;
  if (
    naturalWidth === undefined ||
    naturalHeight === undefined ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return null;
  }

  const explicitWidth = paint.tileSizePx?.width;
  const explicitHeight = paint.tileSizePx?.height;
  if (
    (explicitWidth !== undefined && (!Number.isFinite(explicitWidth) || explicitWidth <= 0)) ||
    (explicitHeight !== undefined && (!Number.isFinite(explicitHeight) || explicitHeight <= 0))
  ) {
    return null;
  }
  const width =
    explicitWidth ??
    (explicitHeight !== undefined ? explicitHeight * (naturalWidth / naturalHeight) : naturalWidth);
  const height =
    explicitHeight ??
    (explicitWidth !== undefined ? explicitWidth * (naturalHeight / naturalWidth) : naturalHeight);
  const roundedWidth = round2(width);
  const roundedHeight = round2(height);
  if (roundedWidth <= 0 || roundedHeight <= 0) return null;

  const positionX = paint.backgroundPosition.x;
  const positionY = paint.backgroundPosition.y;
  return {
    paint,
    width: roundedWidth,
    height: roundedHeight,
    x: round2(
      (bounds.width - width) * (positionX.percentage ?? 0) + (positionX.offsetPx ?? 0),
    ),
    y: round2(
      (bounds.height - height) * (positionY.percentage ?? 0) + (positionY.offsetPx ?? 0),
    ),
  };
}

function positionedBackgroundSuffix(
  fills: Paint[],
  bounds: { width: number; height: number },
  context: ConversionContext,
): PositionedBackgroundSuffix | null {
  const reversedLayers: PositionedBackgroundLayer[] = [];
  let suffixStart = fills.length;
  for (let index = fills.length - 1; index >= 0; index -= 1) {
    const paint = fills[index];
    if (paint === undefined) break;
    const layer = resolvePositionedBackgroundLayer(paint, bounds, context);
    if (layer === null) break;
    reversedLayers.push(layer);
    suffixStart = index;
  }
  if (reversedLayers.length === 0) return null;
  return {
    remainingFills: fills.slice(0, suffixStart),
    layers: reversedLayers.reverse(),
  };
}

function buildPositionedBackgroundFrame(
  node: CaptureElementNode,
  geometry: RenderGeometry,
  suffix: PositionedBackgroundSuffix,
  context: ConversionContext,
): RenderPlanFrameNode {
  context.nodeCount += 1;
  const frame: RenderPlanFrameNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: `${node.name} (positioned backgrounds)`,
    x: 0,
    y: 0,
    width: geometry.width,
    height: geometry.height,
    opacity: 1,
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: "INSIDE",
    effects: [],
    clipsContent: true,
    children: [],
  };
  applyCornerRadii(frame, node.cornerRadii);
  appendPositionedBackgroundLayers(frame, node, suffix, context, 0);
  return frame;
}

function appendPositionedBackgroundLayers(
  frame: RenderPlanFrameNode,
  node: CaptureElementNode,
  suffix: PositionedBackgroundSuffix,
  context: ConversionContext,
  virtualOffsetX: number,
): void {
  for (const [index, layer] of suffix.layers.entries()) {
    context.nodeCount += 1;
    context.usedAssetIds.add(layer.paint.assetId);
    context.fillAssetIds.add(layer.paint.assetId);
    frame.children.push({
      id: nextId(context),
      sourceNodeId: node.id,
      type: "RECTANGLE",
      name: `${node.name} (background image ${index + 1}/${suffix.layers.length})`,
      x: round2(layer.x - virtualOffsetX),
      y: layer.y,
      width: layer.width,
      height: layer.height,
      opacity: 1,
      fills: [
        {
          type: "IMAGE",
          assetId: layer.paint.assetId,
          scaleMode: "FILL",
          opacity: 1,
        },
      ],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: "INSIDE",
      effects: [],
    });
  }
}

function convertElement(
  node: CaptureElementNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanFrameNode {
  context.nodeCount += 1;
  const rotationDegrees =
    node.children.length === 0 && node.rotationDegrees !== undefined && node.rotationDegrees !== 0
      ? node.rotationDegrees
      : undefined;
  const geometry = renderGeometryFromBounds(
    node.bounds,
    parentBounds,
    rotationDegrees,
    node.layoutBounds,
  );
  const convertedBorders = convertBorders(node.borders);
  const multicolorBorderSvgMarkup =
    node.fragmentRects === undefined || node.fragmentRects.length <= 1
      ? buildMulticolorBorderSvgMarkup(
          node.borders,
          geometry.width,
          geometry.height,
          node.cornerRadii,
        )
      : null;
  const strokes = multicolorBorderSvgMarkup === null ? convertedBorders.strokes : [];
  const strokeWeight =
    multicolorBorderSvgMarkup === null ? convertedBorders.strokeWeight : 0;
  const strokeWeights =
    multicolorBorderSvgMarkup === null ? convertedBorders.strokeWeights : undefined;
  const hasFillClipFact = node.children.some(
    (child) => child.type === "text" && child.fillClip !== undefined,
  );
  const hasFragmentPaint = node.fragmentRects !== undefined && node.fragmentRects.length > 1;
  const clonesFragmentDecoration = hasFragmentPaint && node.boxDecorationBreak === "clone";
  const canSlicePositionedBackgroundAcrossFragments =
    hasFragmentPaint &&
    node.boxDecorationBreak === "slice" &&
    node.fragmentInlineDirection !== undefined;
  const positionedBackgroundBounds = canSlicePositionedBackgroundAcrossFragments
    ? {
        width: node.fragmentRects!.reduce((sum, fragment) => sum + fragment.width, 0),
        height: Math.max(...node.fragmentRects!.map((fragment) => fragment.height)),
      }
    : geometry;
  const canMigratePositionedBackgrounds =
    !hasFillClipFact && (!hasFragmentPaint || canSlicePositionedBackgroundAcrossFragments);
  const positionedBackground = canMigratePositionedBackgrounds
    ? positionedBackgroundSuffix(node.fills, positionedBackgroundBounds, context)
    : null;
  const stackingChildren = prepareCrossWrapperStackingChildren(
    node,
    context.paintOrderVersion,
  );
  const frameFills = positionedBackground?.remainingFills ?? node.fills;
  const slicedFragmentFills =
    hasFragmentPaint && !clonesFragmentDecoration && !hasFillClipFact
      ? frameFills.map((paint) => convertPaint(paint, geometry, context)).filter(isPaint)
      : [];
  const frame: RenderPlanFrameNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: node.name,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    opacity: clamp01(node.opacity),
    fills: hasFragmentPaint
      ? []
      : frameFills.map((paint) => convertPaint(paint, geometry, context)).filter(isPaint),
    strokes,
    strokeWeight,
    strokeAlign: "INSIDE",
    effects: convertShadows(
      node.shadows,
      node.blurPx,
      node.backdropBlurPx,
      geometry.width,
      geometry.height,
    ),
    // Single-axis clipping fact (only one of overflow-x/y is hidden). Figma can
    // clip only on both axes, so enable clipping rather than letting decorative
    // elements overflow the canvas; this is closer to browser rendering.
    clipsContent: node.clipsContent || node.clipAxes !== undefined,
    children: [],
  };
  if (hasFillClipFact) {
    // CSS fact: with background-clip:text, every background layer is clipped to
    // the text and the container itself paints no background. Clear frame fills
    // to prevent duplicate paint.
    frame.fills = [];
  }
  if (strokeWeights) {
    frame.strokeWeights = strokeWeights;
  }
  applyCornerRadii(frame, node.cornerRadii);
  // Cross-line inline fragment fact measured by extractor getClientRects.
  // bounds is an AABB spanning multiple lines; painting it directly creates a
  // wide band across the row, such as a wrapped <code> chip in an MDN "See
  // also" section. Move paint to per-line fragment boxes and use the container
  // only for grouping. clone recreates full decoration on every fragment;
  // slice keeps only inline-start/end edges according to measured direction.
  // When the field is absent, preserve the legacy capture's LTR slice output.
  if (node.fragmentRects !== undefined && node.fragmentRects.length > 1) {
    const paintStrokes = frame.strokes;
    const paintStrokeWeight = frame.strokeWeight;
    const paintStrokeWeights = frame.strokeWeights;
    const uniformRadius = frame.cornerRadius ?? 0;
    const paintRadii = frame.cornerRadii;
    const clonedEffects = clonesFragmentDecoration ? frame.effects : [];
    frame.strokes = [];
    frame.strokeWeight = 0;
    if (clonesFragmentDecoration) frame.effects = [];
    delete frame.strokeWeights;
    delete frame.cornerRadius;
    delete frame.cornerRadii;
    const fragmentCount = node.fragmentRects.length;
    let consumedInlineWidth = 0;
    node.fragmentRects.forEach((frag, index) => {
      context.nodeCount += 1;
      const first = index === 0;
      const last = index === fragmentCount - 1;
      const fragGeometry = renderGeometryFromBounds(frag, node.bounds, undefined);
      const clonedPositionedBackground =
        clonesFragmentDecoration && !hasFillClipFact
          ? positionedBackgroundSuffix(node.fills, fragGeometry, context)
          : null;
      const fragmentFills = hasFillClipFact
        ? []
        : clonesFragmentDecoration
          ? (clonedPositionedBackground?.remainingFills ?? node.fills)
              .map((paint) => convertPaint(paint, fragGeometry, context))
              .filter(isPaint)
          : slicedFragmentFills;
      const bg: RenderPlanFrameNode = {
        id: nextId(context),
        sourceNodeId: node.id,
        type: "FRAME",
        name: `${node.name} (fragment ${index + 1}/${fragmentCount})`,
        x: fragGeometry.x,
        y: fragGeometry.y,
        width: fragGeometry.width,
        height: fragGeometry.height,
        opacity: 1,
        fills: fragmentFills,
        strokes: paintStrokes,
        strokeWeight: 0,
        strokeAlign: "INSIDE",
        effects: clonedEffects,
        clipsContent:
          clonedPositionedBackground !== null ||
          (positionedBackground !== null && canSlicePositionedBackgroundAcrossFragments),
        children: [],
      };
      const inlineStartIsLeft = node.fragmentInlineDirection !== "rtl";
      const keepsLeft =
        clonesFragmentDecoration || (inlineStartIsLeft ? first : last);
      const keepsRight =
        clonesFragmentDecoration || (inlineStartIsLeft ? last : first);
      if (paintStrokes.length > 0) {
        // slice omits borders on cut edges; clone keeps a full border per fragment.
        const base = paintStrokeWeights ?? {
          top: paintStrokeWeight,
          right: paintStrokeWeight,
          bottom: paintStrokeWeight,
          left: paintStrokeWeight,
        };
        bg.strokeWeights = {
          top: base.top,
          bottom: base.bottom,
          left: keepsLeft ? base.left : 0,
          right: keepsRight ? base.right : 0,
        };
      }
      const radii = paintRadii ?? {
        topLeft: uniformRadius,
        topRight: uniformRadius,
        bottomRight: uniformRadius,
        bottomLeft: uniformRadius,
      };
      applyCornerRadii(bg, {
        topLeft: keepsLeft ? radii.topLeft : 0,
        bottomLeft: keepsLeft ? radii.bottomLeft : 0,
        topRight: keepsRight ? radii.topRight : 0,
        bottomRight: keepsRight ? radii.bottomRight : 0,
      });
      if (clonedPositionedBackground !== null) {
        appendPositionedBackgroundLayers(
          bg,
          node,
          clonedPositionedBackground,
          context,
          0,
        );
      } else if (positionedBackground !== null && canSlicePositionedBackgroundAcrossFragments) {
        const virtualOffsetX =
          node.fragmentInlineDirection === "rtl"
            ? positionedBackgroundBounds.width - consumedInlineWidth - frag.width
            : consumedInlineWidth;
        appendPositionedBackgroundLayers(
          bg,
          node,
          positionedBackground,
          context,
          virtualOffsetX,
        );
      }
      frame.children.push(bg);
      consumedInlineWidth += frag.width;
    });
  }
  if (positionedBackground && !hasFragmentPaint) {
    frame.children.push(buildPositionedBackgroundFrame(node, geometry, positionedBackground, context));
  }
  if (multicolorBorderSvgMarkup !== null) {
    context.nodeCount += 1;
    frame.children.push({
      id: nextId(context),
      sourceNodeId: node.id,
      type: "SVG",
      name: `${node.name} (multicolor border)`,
      x: 0,
      y: 0,
      width: geometry.width,
      height: geometry.height,
      opacity: 1,
      svgMarkup: multicolorBorderSvgMarkup,
    });
  }
  if (rotationDegrees !== undefined) {
    frame.rotationDegrees = rotationDegrees;
  }
  const blendMode = convertBlendMode(node.mixBlendMode);
  if (blendMode) {
    frame.blendMode = blendMode;
  }
  // Animation fact: a CSS animation or transition was active during capture,
  // so the style is an intermediate frame sample rather than the designed
  // resting state. Forward a warning to make the designer aware.
  if (node.animationState === "running") {
    addWarning(context, {
      code: "animation_mid_state",
      nodeId: node.id,
      count: 1,
    });
  }
  if (
    context.emitAutoLayout &&
    node.layout &&
    positionedBackground === null &&
    !stackingChildren.hoisted
  ) {
    const autoLayout = convertAutoLayout(node.layout, node.padding);
    if (autoLayout) {
      frame.autoLayout = autoLayout;
    }
  }
  // Rotation is not applied to frames that contain children (rotationDegrees
  // affects leaves only), but pass the net rotation fact to descendant text for
  // vertical reading-direction derivation (see ConversionContext).
  const droppedRotation =
    rotationDegrees === undefined && node.rotationDegrees !== undefined ? node.rotationDegrees : 0;
  const previousInheritedRotation = context.inheritedRotationDegrees;
  context.inheritedRotationDegrees = previousInheritedRotation + droppedRotation;
  // Preserve every extractor node. Paint order and animation state are browser
  // facts; conversion must not delete overlapping text by comparing strings.
  for (const child of sortByPaintOrder(stackingChildren.children)) {
    const converted = convertNode(child, node.bounds, context);
    if (converted) {
      frame.children.push(converted);
    }
  }
  context.inheritedRotationDegrees = previousInheritedRotation;
  return node.clipBounds === undefined
    ? frame
    : wrapNodeInClipBounds(node, frame, parentBounds, context);
}

function wrapNodeInClipBounds(
  node: CaptureNode,
  rendered: RenderPlanNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanFrameNode {
  const clipBounds = node.clipBounds;
  if (clipBounds === undefined || clipBounds.width <= 0 || clipBounds.height <= 0) {
    throw new Error("measured clip wrapper requires positive clip bounds");
  }
  const clipGeometry = renderGeometryFromBounds(clipBounds, parentBounds, undefined);
  rendered.x = round2(node.bounds.x - clipBounds.x);
  rendered.y = round2(node.bounds.y - clipBounds.y);
  rendered.name = `${node.name} (clipped paint)`;
  delete rendered.sourceNodeId;
  context.nodeCount += 1;
  return {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: node.name,
    x: clipGeometry.x,
    y: clipGeometry.y,
    width: clipGeometry.width,
    height: clipGeometry.height,
    opacity: 1,
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: "INSIDE",
    effects: [],
    clipsContent: true,
    children: [rendered],
  };
}

const CSS_TO_FIGMA_BLEND: Record<string, FigmaBlendMode> = {
  multiply: "MULTIPLY",
  screen: "SCREEN",
  overlay: "OVERLAY",
  darken: "DARKEN",
  lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE",
  "color-burn": "COLOR_BURN",
  "hard-light": "HARD_LIGHT",
  "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
};

/** Map CSS mix-blend-mode to a Figma blend mode; undefined for normal/unknown. */
function convertBlendMode(cssBlendMode: string | undefined): FigmaBlendMode | undefined {
  if (!cssBlendMode) {
    return undefined;
  }
  return CSS_TO_FIGMA_BLEND[cssBlendMode];
}

/**
 * Consume the sibling-local paint rank measured by the browser extractor.
 * Old captures predate this optional fact, so they retain the bounded legacy
 * CSS reconstruction below for compatibility only.
 *
 * Legacy approximation within a parent:
 * 1. positioned children with negative z-index (ascending)
 * 2. in-flow content (DOM order)
 * 3. positioned children with z-index >= 0 (ascending, DOM order ties)
 * Any capture node may carry browser-measured positioning facts. Screenshot
 * fallbacks are image leaves, but must keep the source element's z-index.
 */
function sortByPaintOrder(children: CaptureNode[]): CaptureNode[] {
  if (children.every((child) => child.paintOrder !== undefined)) {
    return children
      .map((child, index) => ({ child, index }))
      .sort(
        (left, right) =>
          (left.child.paintOrder ?? 0) - (right.child.paintOrder ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.child);
  }
  const hasParticipatingStackingFact = (
    node: CaptureNode,
    peers: CaptureNode[],
  ): boolean => {
    // Positive-z positioned descendants that overlap a sibling of the plain
    // wrapper participate in the ancestor paint band — whether they overflow
    // the wrapper (NatGeo #nav-container) or stay contained (GitLab
    // input-group buttons sitting 1px over the mid field).
    if (
      node.positioned === true &&
      node.zIndex !== undefined &&
      node.zIndex >= 0 &&
      peers.some(
        (peer) =>
          captureNodeHasPaintContribution(peer) &&
          rectsOverlapOrNearlyTouch(node.bounds, peer.bounds),
      )
    ) {
      return true;
    }
    if (node.type !== "element" || node.createsStackingContext === true) {
      return false;
    }
    return node.children.some((child) => hasParticipatingStackingFact(child, peers));
  };
  const needsSort = children.some((child) => {
    if (child.zIndex !== undefined || child.positioned === true) {
      return true;
    }
    if (child.type !== "element" || child.createsStackingContext === true) {
      return false;
    }
    const peers = children.filter((peer) => peer !== child);
    return child.children.some((descendant) =>
      hasParticipatingStackingFact(descendant, peers),
    );
  });
  if (!needsSort) {
    return children;
  }
  // Effective z level: explicit z-index wins (it also applies to static
  // flex/grid items); positioned elements with z-index auto paint above
  // in-flow content (CSS2.1 Appendix E step 8 vs 4), i.e. at least level 0.
  // Positive z-index descendants of a positioned-auto container participate in
  // the ancestor's stacking context, so bubble them through that container.
  // Transparent non-positioned wrappers are split only when the escaping
  // child's own paint intersects a sibling; otherwise a distant decorative
  // glyph must not lift the wrapper's background with it.
  const peersByChild = new Map<CaptureNode, CaptureNode[]>();
  for (const child of children) {
    peersByChild.set(
      child,
      children.filter((peer) => peer !== child),
    );
  }
  const maxDescendantZ = (node: CaptureNode, peers: CaptureNode[]): number | undefined => {
    let max: number | undefined;
    const children = "children" in node ? (node.children ?? []) : [];
    for (const child of children) {
      // Stacking-context fact: an element that creates a stacking context
      // contains descendant z-index values so they no longer bubble to
      // ancestors. This is CSS semantics read directly from capture facts.
      const relevant = isRelevantToSiblingPaintBand(child, peers);
      let own: number | undefined;
      if (child.zIndex !== undefined && relevant) {
        own = child.zIndex;
      } else if (child.createsStackingContext === true) {
        // Positioned auto/transform/opacity contexts participate at stack
        // level zero, while still sealing their descendants.
        own = child.positioned === true && relevant ? 0 : undefined;
        } else if (child.type === "element") {
          own = maxDescendantZ(child, peers);
          // A positioned z-index:auto descendant belongs to the ancestor's
          // positioned-auto band. Bubble level zero through positioned
          // wrappers. A non-positioned transparent wrapper does not get to
          // lift its entire background merely because a deeply nested
          // decorative child has a positive z-index; the cross-wrapper
          // splitter handles a child whose own paint actually escapes.
          if (child.positioned === true && relevant) {
            own = Math.max(0, own ?? 0);
          } else if (child.positioned !== true) {
            own = undefined;
          }
      } else if (child.positioned === true && relevant) {
        own = 0;
      }
      if (own !== undefined && own >= 0 && (max === undefined || own > max)) {
        max = own;
      }
    }
    return max;
  };
  const zInfoOf = (child: CaptureNode): { explicit: boolean; z: number | undefined } => {
    if (child.zIndex !== undefined) {
      return { explicit: true, z: child.zIndex };
    }
    // A stacking context is atomic in its parent's paint order. Its own
    // positioned-auto level is zero, but positive z-index descendants stay
    // sealed inside and must not lift the entire context above sibling
    // headers/content in the ancestor context.
    if (child.createsStackingContext === true) {
      return {
        explicit: false,
        z: child.positioned === true ? 0 : undefined,
      };
    }
    const descendantZ =
      child.type === "element" ? maxDescendantZ(child, peersByChild.get(child) ?? []) : undefined;
    if (child.positioned === true) {
      return { explicit: false, z: descendantZ !== undefined ? Math.max(0, descendantZ) : 0 };
    }
    return { explicit: false, z: descendantZ };
  };
  const zInfoByChild = new Map(children.map((child) => [child, zInfoOf(child)]));
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => {
      const infoA = zInfoByChild.get(a.child) ?? { explicit: false, z: undefined };
      const infoB = zInfoByChild.get(b.child) ?? { explicit: false, z: undefined };
      const za = infoA.z;
      const zb = infoB.z;
      const groupA = za === undefined ? 0 : za < 0 ? -1 : 1;
      const groupB = zb === undefined ? 0 : zb < 0 ? -1 : 1;
      if (groupA !== groupB) {
        return groupA - groupB;
      }
      if (groupA !== 0 && za !== zb) {
        return (za ?? 0) - (zb ?? 0);
      }
      return a.index - b.index;
    })
    .map((entry) => entry.child);
}

function captureNodeHasPaintContribution(node: CaptureNode): boolean {
  if (node.type === "text" || node.type === "image" || node.type === "svg") {
    return true;
  }
  return (
    node.fills.length > 0 ||
    node.borders !== undefined ||
    (node.shadows?.length ?? 0) > 0 ||
    (node.blurPx ?? 0) > 0 ||
    (node.backdropBlurPx ?? 0) > 0 ||
    node.children.some(captureNodeHasPaintContribution)
  );
}

function canHoistStackingChildThrough(node: CaptureElementNode): boolean {
  return (
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
    node.fragmentRects === undefined
  );
}

function withoutSiblingPaintOrder(node: CaptureNode): CaptureNode {
  const copy = { ...node };
  delete copy.paintOrder;
  return copy;
}

function ancestorPaintOrderFor(node: CaptureNode, ancestorId: string): number | undefined {
  return node.ancestorPaintOrders?.find((fact) => fact.ancestorId === ancestorId)?.order;
}

function withPaintOrder(node: CaptureNode, paintOrder: number | undefined): CaptureNode {
  return paintOrder === undefined ? node : ({ ...node, paintOrder } as CaptureNode);
}

function prepareMeasuredCrossWrapperStackingChildren(parent: CaptureElementNode): {
  children: CaptureNode[];
  hoisted: boolean;
} {
  const ancestorId = parent.id;
  const hasEscapingFact = (node: CaptureNode, direct: boolean): boolean => {
    if (!direct && ancestorPaintOrderFor(node, ancestorId) !== undefined) return true;
    return node.type === "element" && node.children.some((child) => hasEscapingFact(child, false));
  };
  if (!parent.children.some((child) => hasEscapingFact(child, true))) {
    return { children: parent.children, hoisted: false };
  }

  const splitWrapper = (
    wrapper: CaptureElementNode,
  ): { wrapper: CaptureElementNode; hoisted: CaptureNode[] } => {
    if (!canHoistStackingChildThrough(wrapper)) {
      return { wrapper, hoisted: [] };
    }
    const lifted: CaptureNode[] = [];
    const remainingChildren: CaptureNode[] = [];
    for (const child of wrapper.children) {
      const measuredOrder = ancestorPaintOrderFor(child, ancestorId);
      if (measuredOrder !== undefined) {
        lifted.push(withPaintOrder(child, measuredOrder));
        continue;
      }
      if (child.type === "element") {
        const nested = splitWrapper(child);
        remainingChildren.push(nested.wrapper);
        lifted.push(...nested.hoisted);
        continue;
      }
      remainingChildren.push(child);
    }
    if (lifted.length === 0) {
      return { wrapper, hoisted: [] };
    }
    return {
      wrapper: {
        ...wrapper,
        children: remainingChildren,
      },
      hoisted: lifted,
    };
  };

  let hoisted = false;
  const output: CaptureNode[] = [];
  for (const child of parent.children) {
    const directOrder = ancestorPaintOrderFor(child, ancestorId);
    if (child.type !== "element") {
      output.push(withPaintOrder(child, directOrder));
      continue;
    }
    const split = splitWrapper(child);
    output.push(withPaintOrder(split.wrapper, directOrder), ...split.hoisted);
    if (split.hoisted.length > 0) hoisted = true;
  }
  return { children: output, hoisted };
}

function prepareLegacyCrossWrapperStackingChildren(children: CaptureNode[]): {
  children: CaptureNode[];
  hoisted: boolean;
} {
  let hoisted = false;
  const output: CaptureNode[] = [];

  const splitWrapper = (
    wrapper: CaptureElementNode,
    peers: CaptureNode[],
    requireRemainingPaint: boolean,
  ): { wrapper: CaptureElementNode; hoisted: CaptureNode[] } => {
    if (!canHoistStackingChildThrough(wrapper)) {
      return { wrapper, hoisted: [] };
    }
    const lifted: CaptureNode[] = [];
    const remainingChildren: CaptureNode[] = [];
    for (const child of wrapper.children) {
      const overlapsExternalPaint = peers.some(
        (peer) =>
          captureNodeHasPaintContribution(peer) &&
          rectsOverlapForCrossWrapperHoist(child.bounds, peer.bounds),
      );
      if ((child.zIndex ?? 0) > 0 && overlapsExternalPaint) {
        lifted.push(withoutSiblingPaintOrder(child));
        continue;
      }
      if (child.type === "element" && canHoistStackingChildThrough(child)) {
        const nested = splitWrapper(child, peers, false);
        remainingChildren.push(nested.wrapper);
        lifted.push(...nested.hoisted);
        continue;
      }
      remainingChildren.push(child);
    }
    if (lifted.length === 0) {
      return { wrapper, hoisted: [] };
    }
    const split = { ...wrapper, children: remainingChildren };
    if (requireRemainingPaint && !captureNodeHasPaintContribution(split)) {
      return { wrapper, hoisted: [] };
    }
    return {
      wrapper: withoutSiblingPaintOrder(split) as CaptureElementNode,
      hoisted: lifted,
    };
  };

  for (const child of children) {
    if (child.type !== "element") {
      output.push(child);
      continue;
    }
    const peers = children.filter((peer) => peer !== child);
    const split = splitWrapper(child, peers, true);
    output.push(split.wrapper, ...split.hoisted);
    if (split.hoisted.length > 0) hoisted = true;
  }
  return { children: output, hoisted };
}

function prepareCrossWrapperStackingChildren(
  parent: CaptureElementNode,
  paintOrderVersion: 1 | undefined,
): { children: CaptureNode[]; hoisted: boolean } {
  return paintOrderVersion === 1
    ? prepareMeasuredCrossWrapperStackingChildren(parent)
    : prepareLegacyCrossWrapperStackingChildren(parent.children);
}

function isRelevantToSiblingPaintBand(child: CaptureNode, siblings: CaptureNode[]): boolean {
  return siblings.some((sibling) => rectsOverlapOrNearlyTouch(child.bounds, sibling.bounds));
}

/**
 * Cross-wrapper hoisting must require a real paint intersection. The broader
 * sibling paint-band tolerance is useful for legacy z-order reconstruction,
 * but applying its 96px band here lifts cards that merely sit near a heading
 * out of their authored stacking context (and breaks ordinary fixture grids).
 */
function rectsOverlapForCrossWrapperHoist(
  a: CaptureNode["bounds"],
  b: CaptureNode["bounds"],
): boolean {
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;
  const aBottom = a.y + a.height;
  const bBottom = b.y + b.height;
  return a.x < bRight && aRight > b.x && a.y < bBottom && aBottom > b.y;
}

function rectsOverlapOrNearlyTouch(a: CaptureNode["bounds"], b: CaptureNode["bounds"]): boolean {
  const margin = 96;
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;
  const aBottom = a.y + a.height;
  const bBottom = b.y + b.height;
  return a.x < bRight && aRight > b.x && a.y - margin < bBottom && aBottom + margin > b.y;
}

function convertText(
  node: CaptureTextNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode {
  // Required pixel fallbacks (glyph-fallback face / PUA) must ship as the
  // measured raster. Optional fontFallbackAssetId stays on editable TEXT;
  // preview/plugin consume it only when the authored family cannot resolve.
  if (
    node.fontFallbackRequired === true &&
    node.fontFallbackAssetId !== undefined &&
    context.assetsById.has(node.fontFallbackAssetId)
  ) {
    return convertMeasuredTextPixelFallback(node, parentBounds, context);
  }
  // Line-anchor drift: browser fragments in multiline text do not necessarily
  // share one alignment box. A common case is an inline link in a centered
  // paragraph that starts at the end of a preceding line and continues onto the
  // next. Although it inherits text-align:center, its own lines are not centered
  // around the link AABB. A single Figma TEXT node can use only one
  // left/center/right anchor, which pulls the first line back into the box and
  // overlaps preceding text. Compare browser-measured line anchors directly;
  // when they differ, split by line and consume each measuredLines geometry fact.
  const lines = node.measuredLines;
  if (
    lines !== undefined &&
    lines.length > 1 &&
    measuredLineAnchorDrift(lines, node.style.textAlign) >
      measuredLineAnchorTolerance(node.style)
  ) {
    if (
      node.fontFallbackAssetId !== undefined &&
      context.assetsById.has(node.fontFallbackAssetId) &&
      (node.segments.length <= 1 || node.fontFallbackRequired === true)
    ) {
      return convertMeasuredTextPixelFallback(node, parentBounds, context);
    }
    const split = convertTextPerLine(node, parentBounds, context);
    if (split !== null) {
      return split;
    }
  }
  return convertSingleText(node, parentBounds, context);
}

function convertMeasuredTextPixelFallback(
  node: CaptureTextNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode {
  const assetId = node.fontFallbackAssetId!;
  context.nodeCount += 1;
  context.usedAssetIds.add(assetId);
  context.fillAssetIds.add(assetId);
  return {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "RECTANGLE",
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width: Math.max(1, round2(node.bounds.width)),
    height: Math.max(1, round2(node.bounds.height)),
    opacity: clamp01(node.opacity),
    fills: [
      {
        type: "IMAGE",
        assetId,
        scaleMode: "FIT",
        opacity: 1,
      },
    ],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: "INSIDE",
    effects: convertShadows(node.shadows, undefined),
  };
}

function measuredLineAnchorDrift(
  lines: TextLineBox[],
  align: CaptureTextNode["style"]["textAlign"],
): number {
  const anchors = lines.map((line) => {
    if (align === "center") return line.x + line.width / 2;
    if (align === "right") return line.x + line.width;
    return line.x;
  });
  return Math.max(...anchors) - Math.min(...anchors);
}

function measuredLineAnchorTolerance(style: TextStyle): number {
  // Range boxes follow glyph ink/overhang, so ordinary centered/right lines
  // can differ by several pixels even though the browser uses one alignment
  // axis. Half an em bounds that measurement noise; true inline continuation
  // fragments drift by substantially more (and still split per measured line).
  return style.textAlign === "center" || style.textAlign === "right"
    ? Math.max(1, style.fontSizePx * 0.5)
    : 1;
}

/**
 * Split measuredLines rectangles into a transparent FRAME with one TEXT node
 * per line. Return null and keep the conservative single-node path when line
 * text does not align with characters.
 */
function convertTextPerLine(
  node: CaptureTextNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanFrameNode | null {
  const lines = node.measuredLines;
  if (lines === undefined) {
    return null;
  }
  const characters = applyTextTransform(node.text, node.style.textTransform);
  const charLines = characters.split("\n");
  if (charLines.length !== lines.length) {
    return null;
  }
  context.nodeCount += 1;
  const frame: RenderPlanFrameNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width: Math.max(1, round2(node.bounds.width)),
    height: Math.max(1, round2(node.bounds.height)),
    opacity: clamp01(node.opacity),
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: "INSIDE",
    effects: [],
    clipsContent: false,
    children: [],
  };
  const fullSegments = buildSegments(node, context);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = offset;
    const lineEnd = offset + charLines[i]!.length;
    offset = lineEnd + 1; // Skip \n.
    // Position each line TEXT relative to the frame whose absolute origin is
    // the original node bounds origin.
    const lineCaptureNode: CaptureTextNode = {
      ...node,
      text: charLines[i]!,
      bounds: line,
      measuredLines: [line],
      segments: [],
    };
    // The optional fallback asset contains the complete paragraph. Reusing it
    // inside every independently positioned line would squeeze the whole
    // paragraph into each line box when the target runtime misses the font.
    // Keep these mixed-style lines editable and let the plugin's bounded font
    // substitution path handle an unavailable family.
    delete lineCaptureNode.fontFallbackAssetId;
    delete lineCaptureNode.fontFallbackRequired;
    const lineNode = convertSingleText(
      lineCaptureNode,
      { x: node.bounds.x, y: node.bounds.y, width: node.bounds.width, height: node.bounds.height },
      context,
    );
    // convertSingleText does not emit runs for empty segments. Remap full-text
    // segments to each line range.
    const lineSegments = fullSegments
      .map((seg) => ({
        ...seg,
        start: Math.max(seg.start, lineStart) - lineStart,
        end: Math.min(seg.end, lineEnd) - lineStart,
      }))
      .filter((seg) => seg.start < seg.end);
    if (lineSegments.length > 1) {
      lineNode.segments = lineSegments;
    } else if (lineSegments.length === 1) {
      // For a line with one run, promote run style to the line node to keep the
      // structure compact.
      const only = lineSegments[0]!;
      lineNode.fontFamily = only.fontFamily;
      lineNode.fontStyle = only.fontStyle;
      lineNode.fontSizePx = only.fontSizePx;
      if (only.color !== undefined) {
        lineNode.fills = [solidPaint(only.color)];
      }
      if (only.textDecoration !== undefined) {
        lineNode.textDecoration = only.textDecoration;
      }
    }
    frame.children.push(lineNode);
  }
  return frame;
}

function convertSingleText(
  node: CaptureTextNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanTextNode {
  context.nodeCount += 1;
  context.textNodeCount += 1;

  const style = node.style;
  const fontStyle = figmaFontStyle(style.fontWeight, style.italic);
  const fontFamily = effectiveFontFamily(style);
  const lineHeightPx = resolvedLineHeightPx(node);
  registerFont(context, fontFamily, fontStyle);

  // Vertical-writing fact: Figma has no native vertical text, but sideways
  // glyphs are equivalent to rotated horizontal text. vertical-rl/vertical-lr
  // (except upright) and sideways-rl rotate 90 degrees clockwise;
  // sideways-lr rotates 90 degrees counterclockwise. Combine this with dropped
  // ancestor rotation to obtain the net angle. For example, an MDN BCD header
  // using vertical-rl inside rotate(180deg) becomes -90 degrees and reads
  // bottom-to-top. Plan rotation follows extractor/preview conventions:
  // positive is CSS clockwise around the node center. Use an unrotated
  // horizontal node box centered on the captured AABB with width and height
  // swapped. text-orientation: upright leaves glyphs unrotated and cannot be
  // represented by this model, so emit an explicit fallback warning rather
  // than applying an incorrect rotation.
  let verticalRotationDegrees: number | undefined;
  if (node.writingMode !== undefined && node.textOrientation === "upright") {
    addWarning(context, {
      code: "vertical_text_unsupported",
      nodeId: node.id,
      count: 1,
      detail: `${node.writingMode} upright`,
    });
  } else if (
    node.writingMode === "vertical-rl" ||
    node.writingMode === "vertical-lr" ||
    node.writingMode === "sideways-rl"
  ) {
    verticalRotationDegrees = normalizeDegrees(90 + context.inheritedRotationDegrees);
  } else if (node.writingMode === "sideways-lr") {
    verticalRotationDegrees = normalizeDegrees(-90 + context.inheritedRotationDegrees);
  }

  const segments = buildSegments(node, context);

  // Text fill: background-clip:text is a measured fact. Color text with the
  // container fills (gradient or image) rather than style.color, which is often
  // transparent and otherwise falls back to black.
  let textFills: FigmaPaint[] = [solidPaint(style.color)];
  if (node.fillClip !== undefined && node.fillClip.fills.length > 0) {
    const clipFills = node.fillClip.fills
      .map((paint) =>
        convertPaint(paint, { width: node.bounds.width, height: node.bounds.height }, context),
      )
      .filter((paint): paint is FigmaPaint => paint !== null);
    if (clipFills.length > 0) {
      textFills = clipFills;
    }
  }

  const text: RenderPlanTextNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "TEXT",
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width: Math.max(1, round2(node.bounds.width)),
    height: Math.max(1, round2(node.bounds.height)),
    opacity: clamp01(node.opacity),
    characters: applyTextTransform(node.text, style.textTransform),
    fontFamily,
    fontStyle,
    fontSizePx: style.fontSizePx,
    lineHeightPx,
    letterSpacingPx: style.letterSpacingPx,
    fills: textFills,
    textAlignHorizontal: mapTextAlign(style.textAlign),
    textDecoration: mapDecoration(style.textDecoration),
    textCase: mapTextCase(style.textTransform),
    textAutoResize: textAutoResizeMode(node),
    effects: convertShadows(node.shadows, undefined),
  };
  if (
    node.fontFallbackAssetId !== undefined &&
    context.assetsById.has(node.fontFallbackAssetId)
  ) {
    text.fontFallbackAssetId = node.fontFallbackAssetId;
    if (node.fontFallbackRequired === true) {
      text.fontFallbackRequired = true;
    }
    context.usedAssetIds.add(node.fontFallbackAssetId);
    context.fillAssetIds.add(node.fontFallbackAssetId);
  }
  if (segments.length > 1) {
    text.segments = segments;
  }
  if (verticalRotationDegrees !== undefined) {
    // Unrotated horizontal box centered on the captured AABB with width and
    // height swapped for a 90-degree rotation.
    const { bounds } = node;
    text.width = Math.max(1, round2(bounds.height));
    text.height = Math.max(1, round2(bounds.width));
    text.x = round2(bounds.x + (bounds.width - bounds.height) / 2 - parentBounds.x);
    text.y = round2(bounds.y + (bounds.height - bounds.width) / 2 - parentBounds.y);
    text.rotationDegrees = verticalRotationDegrees;
    // Preserve captured inline width before rotation. When browser line-box
    // facts are absent, fix this width so the target font cannot expand an
    // entire vertical passage into an unbounded line.
    text.textAutoResize = node.measuredLines !== undefined ? "WIDTH_AND_HEIGHT" : "HEIGHT";
  }
  return text;
}

/** Normalize an angle to (-180, 180] for the smallest downstream rotation. */
function normalizeDegrees(degrees: number): number {
  let d = degrees % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function textAutoResizeMode(node: CaptureTextNode): RenderPlanTextNode["textAutoResize"] {
  // Measured fact: the extractor enumerated real browser line boxes and baked
  // breaks into text with \n. Use hug sizing (WIDTH_AND_HEIGHT) for both single
  // and multiline text so line count exactly matches the measurement. With
  // fixed-width HEIGHT, a wider fallback font wraps again on top of baked line
  // breaks, inflating line count and overlapping content below. With hug sizing,
  // the fallback font can only extend a line horizontally, which is less
  // destructive and keeps measured line breaks authoritative.
  if (node.measuredLines !== undefined) {
    return "WIDTH_AND_HEIGHT";
  }
  // Without measuredLines, captured width is the only reliable geometry fact.
  // HEIGHT preserves that width and lets the target runtime grow with its
  // actual font. WIDTH_AND_HEIGHT removes the width constraint and stretches
  // text with unknown wrapping into an unreadable line. Explicit pre/BR breaks
  // use the same path.
  return "HEIGHT";
}

function resolvedLineHeightPx(node: CaptureTextNode): number {
  const fontSize = Math.max(node.style.fontSizePx, 1);
  const styleLineHeight = Math.max(node.style.lineHeightPx, 1);
  const capturedHeight = Math.max(node.bounds.height, 1);
  if (normalLineHeightNeedsAdjustment(node, fontSize, styleLineHeight, capturedHeight)) {
    return round2(Math.min(capturedHeight, fontSize * FALLBACK_LINE_HEIGHT_RATIO));
  }
  return styleLineHeight;
}

// There is intentionally no y-offset correction here. A text node's y/height
// are captured font-box facts. Both preview correction and Figma text-box
// layout position the baseline from height. Adding another conversion offset
// would double-correct it and push text below neighboring icons, which caused
// MDN navigation text to sit 2px below its chevron.
function normalLineHeightNeedsAdjustment(
  node: CaptureTextNode,
  fontSize: number,
  styleLineHeight: number,
  capturedHeight: number,
): boolean {
  return (
    !node.text.includes("\n") &&
    styleLineHeight <= fontSize * SINGLE_LINE_STYLE_HEIGHT_RATIO_MAX &&
    capturedHeight > styleLineHeight * SINGLE_LINE_CAPTURED_MIN_RATIO &&
    capturedHeight < styleLineHeight * SINGLE_LINE_CAPTURED_MAX_RATIO
  );
}

function buildSegments(
  node: CaptureTextNode,
  context: ConversionContext,
): RenderPlanTextSegment[] {
  const segments: RenderPlanTextSegment[] = [];
  let cursor = 0;
  for (const segment of node.segments) {
    const rendered = applyTextTransform(segment.text, segment.style.textTransform);
    const start = cursor;
    const end = cursor + rendered.length;
    cursor = end;
    const fontStyle = figmaFontStyle(segment.style.fontWeight, segment.style.italic);
    const fontFamily = effectiveFontFamily(segment.style);
    registerFont(context, fontFamily, fontStyle);
    segments.push({
      start,
      end,
      fontFamily,
      fontStyle,
      fontSizePx: segment.style.fontSizePx,
      color: segment.style.color,
      letterSpacingPx: segment.style.letterSpacingPx,
      textDecoration: mapDecoration(segment.style.textDecoration),
    });
  }
  return segments;
}

function effectiveFontFamily(style: TextStyle): string {
  return style.renderedFontFamily ?? style.fontFamily;
}

function convertImage(
  node: CaptureImageNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode {
  context.nodeCount += 1;
  const withMeasuredClip = (rendered: RenderPlanNode): RenderPlanNode =>
    node.clipBounds === undefined
      ? rendered
      : wrapNodeInClipBounds(node, rendered, parentBounds, context);
  const asset = node.assetId ? context.assetsById.get(node.assetId) : undefined;
  let imageFillAsset = asset;

  // Live-rendered content (WebGL) that produced unusable pixels on this
  // host: emit an explicit labeled placeholder so designers see a clear
  // to-do instead of broken white silhouettes.
  if (node.renderFallback === true && asset === undefined) {
    return withMeasuredClip(buildRenderFallbackFrame(node, parentBounds, context));
  }

  // SVG-backed images become vector nodes so Figma keeps them crisp.
  if (asset && (asset.kind === "svg-inline" || asset.kind === "svg-image")) {
    const svgMarkup = svgMarkupFromAsset(asset);
    if (svgMarkup === null) {
      addWarning(context, {
        code: "asset_fetch_failed",
        nodeId: node.id,
        count: 1,
        detail: "invalid SVG image asset",
      });
      imageFillAsset = undefined;
    } else {
      context.usedAssetIds.add(asset.assetId);
      const clippedSvg = buildClippedSvgImage(node, parentBounds, context, svgMarkup);
      if (clippedSvg !== null) {
        return withMeasuredClip(clippedSvg);
      }
      return withMeasuredClip({
        id: nextId(context),
        sourceNodeId: node.id,
        type: "SVG",
        name: node.name,
        x: round2(node.bounds.x - parentBounds.x),
        y: round2(node.bounds.y - parentBounds.y),
        width: Math.max(1, round2(node.bounds.width)),
        height: Math.max(1, round2(node.bounds.height)),
        opacity: clamp01(node.opacity),
        svgMarkup,
      });
    }
  }

  const { strokes, strokeWeight } = convertBorders(node.borders);
  const rect: RenderPlanNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "RECTANGLE",
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width: Math.max(1, round2(node.bounds.width)),
    height: Math.max(1, round2(node.bounds.height)),
    opacity: clamp01(node.opacity),
    fills: [],
    strokes,
    strokeWeight,
    strokeAlign: "INSIDE",
    effects: convertShadows(node.shadows, undefined),
  };
  applyCornerRadii(rect, node.cornerRadii);

  if (imageFillAsset) {
    context.usedAssetIds.add(imageFillAsset.assetId);
    context.fillAssetIds.add(imageFillAsset.assetId);
    rect.fills = [
      {
        type: "IMAGE",
        assetId: imageFillAsset.assetId,
        scaleMode: mapScaleMode(node.scaleMode),
        opacity: 1,
      },
    ];
  } else {
    // Placeholder for missing assets: neutral fill, keeps geometry.
    rect.fills = [solidPaint({ r: 0.93, g: 0.93, b: 0.94, a: 1 })];
    addWarning(context, {
      code: "asset_fetch_failed",
      nodeId: node.id,
      count: 1,
      detail: "image placeholder emitted",
    });
  }
  return withMeasuredClip(rect);
}

function buildClippedSvgImage(
  node: CaptureImageNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
  svgMarkup: string,
): RenderPlanNode | null {
  if (node.scaleMode !== "fill") {
    return null;
  }
  const naturalWidth = node.naturalWidth;
  const naturalHeight = node.naturalHeight;
  if (
    naturalWidth === undefined ||
    naturalHeight === undefined ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return null;
  }
  const width = Math.max(1, round2(node.bounds.width));
  const height = Math.max(1, round2(node.bounds.height));
  const scale = Math.max(width / naturalWidth, height / naturalHeight);
  const childWidth = round2(naturalWidth * scale);
  const childHeight = round2(naturalHeight * scale);
  const childX = round2((width - childWidth) / 2);
  const childY = round2((height - childHeight) / 2);
  if (
    Math.abs(childX) < 0.01 &&
    Math.abs(childY) < 0.01 &&
    Math.abs(childWidth - width) < 0.01 &&
    Math.abs(childHeight - height) < 0.01
  ) {
    return null;
  }

  const { strokes, strokeWeight } = convertBorders(node.borders);
  const frame: RenderPlanNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width,
    height,
    opacity: clamp01(node.opacity),
    fills: [],
    strokes,
    strokeWeight,
    strokeAlign: "INSIDE",
    effects: convertShadows(node.shadows, undefined),
    clipsContent: true,
    children: [
      {
        id: nextId(context),
        sourceNodeId: node.id,
        type: "SVG",
        name: node.name,
        x: childX,
        y: childY,
        width: childWidth,
        height: childHeight,
        opacity: 1,
        svgMarkup,
      },
    ],
  };
  applyCornerRadii(frame, node.cornerRadii);
  return frame;
}

function renderFallbackPresentation(node: CaptureImageNode): {
  heading: string;
  name: string;
} {
  // `tag` is a browser-captured fact. Keep the category deliberately broad:
  // a canvas may be WebGL or 2D, while an ordinary element fallback may be a
  // masked/animated subtree. The previous unconditional "3D/WebGL" label
  // misdiagnosed div and iframe failures across the URL benchmark.
  switch (node.tag) {
    case "canvas":
      return {
        heading: "Canvas/WebGL content unavailable",
        name: "Canvas/WebGL fallback",
      };
    case "iframe":
      return {
        heading: "Embedded content unavailable",
        name: "Embedded content fallback",
      };
    case "video":
      return {
        heading: "Video frame unavailable",
        name: "Video fallback",
      };
    default:
      return {
        heading: "Dynamic content unavailable",
        name: "Dynamic content fallback",
      };
  }
}

/**
 * Labeled placeholder for content that could not be rendered on this host.
 * Distinct visual treatment (dark translucent fill + accent stroke + centered
 * label) makes the degradation explicit without inventing a WebGL diagnosis
 * for non-canvas content.
 */
function buildRenderFallbackFrame(
  node: CaptureImageNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode {
  const width = Math.max(1, round2(node.bounds.width));
  const height = Math.max(1, round2(node.bounds.height));
  const presentation = renderFallbackPresentation(node);
  const capturedLabel = node.fallbackLabel ?? node.altText;
  // Older captures wrote this sentinel for every failed raster target,
  // including divs and iframes. It carries no accessible-name information.
  const label = capturedLabel === "WebGL content" ? undefined : capturedLabel;
  const fontSize = Math.min(16, Math.max(11, Math.round(height / 12)));
  const lineHeight = Math.round(fontSize * 1.4);
  addWarning(context, {
    code: "asset_fetch_failed",
    nodeId: node.id,
    count: 1,
    detail: `render fallback placeholder emitted: ${label ?? presentation.heading}`,
  });
  const text: RenderPlanNode = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "TEXT",
    name: "fallback-label",
    x: 0,
    y: round2(height / 2 - lineHeight),
    width,
    height: lineHeight * 2,
    opacity: 1,
    characters:
      label === undefined
        ? `[${presentation.heading}]`
        : `[${presentation.heading}]\n${label}`,
    fontFamily: "Inter",
    fontStyle: "Medium",
    fontSizePx: fontSize,
    lineHeightPx: lineHeight,
    letterSpacingPx: 0,
    fills: [solidPaint({ r: 0.62, g: 0.65, b: 0.75, a: 1 })],
    textAlignHorizontal: "CENTER",
    textDecoration: "NONE",
    textCase: "ORIGINAL",
    textAutoResize: "NONE",
    effects: [],
  };
  return {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "FRAME",
    name: label === undefined ? presentation.name : `${presentation.name}: ${label}`,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width,
    height,
    opacity: clamp01(node.opacity),
    fills: [solidPaint({ r: 0.09, g: 0.1, b: 0.14, a: 0.55 })],
    strokes: [solidPaint({ r: 0.45, g: 0.5, b: 0.85, a: 0.8 })],
    strokeWeight: 1,
    strokeAlign: "INSIDE",
    cornerRadius: 8,
    effects: [],
    clipsContent: true,
    children: [text],
  };
}

function convertSvg(
  node: CaptureSvgNode,
  parentBounds: ParentBounds,
  context: ConversionContext,
): RenderPlanNode | null {
  context.nodeCount += 1;
  const asset = node.assetId ? context.assetsById.get(node.assetId) : undefined;
  const base = {
    id: nextId(context),
    sourceNodeId: node.id,
    type: "SVG" as const,
    name: node.name,
    x: round2(node.bounds.x - parentBounds.x),
    y: round2(node.bounds.y - parentBounds.y),
    width: Math.max(1, round2(node.bounds.width)),
    height: Math.max(1, round2(node.bounds.height)),
    opacity: clamp01(node.opacity),
  };
  if (asset && isInlineSvgAsset(asset)) {
    const svgMarkup = svgMarkupFromAsset(asset);
    if (svgMarkup !== null) {
      context.usedAssetIds.add(asset.assetId);
      return { ...base, svgMarkup };
    }
    return null;
  }
  if (asset) {
    context.usedAssetIds.add(asset.assetId);
    return { ...base, assetId: asset.assetId };
  }
  return null;
}

function isInlineSvgAsset(asset: CaptureAsset): boolean {
  return asset.kind === "svg-inline" || asset.kind === "svg-image";
}

function svgMarkupFromAsset(asset: CaptureInlineAsset): string | null {
  const data = asset.data.trim();
  if (!data.startsWith("data:")) {
    return isSafeSvgMarkup(data) ? data : null;
  }
  const bytes = decodeDataUri(data);
  if (bytes === null) {
    return null;
  }
  const markup = new TextDecoder().decode(bytes).trim();
  return isSafeSvgMarkup(markup) ? markup : null;
}

// ---------------------------------------------------------------------------
// Paint conversion
// ---------------------------------------------------------------------------

function isPaint(paint: FigmaPaint | null): paint is FigmaPaint {
  return paint !== null;
}

function solidPaint(color: RgbaColor): FigmaPaint {
  return {
    type: "SOLID",
    color: { r: color.r, g: color.g, b: color.b },
    opacity: clamp01(color.a),
  };
}

function figmaGradientStops(
  stops: Array<{ position: number; color: RgbaColor }>,
): Array<{ position: number; color: RgbaColor }> {
  const converted = stops.map((stop) => ({
    position: clamp01(stop.position),
    color: { ...stop.color },
  }));
  const firstVisible = converted.find((stop) => stop.color.a > 0);
  if (firstVisible !== undefined) {
    for (const stop of converted) {
      if (stop.color.a > 0) break;
      stop.color = { ...firstVisible.color, a: 0 };
    }
  }
  let lastVisible: (typeof converted)[number] | undefined;
  for (let index = converted.length - 1; index >= 0; index -= 1) {
    const stop = converted[index];
    if (stop !== undefined && stop.color.a > 0) {
      lastVisible = stop;
      break;
    }
  }
  if (lastVisible !== undefined) {
    for (let index = converted.length - 1; index >= 0; index -= 1) {
      const stop = converted[index];
      if (stop === undefined || stop.color.a > 0) break;
      stop.color = { ...lastVisible.color, a: 0 };
    }
  }
  return converted;
}

function convertPaint(
  paint: Paint,
  bounds: { width: number; height: number },
  context: ConversionContext,
): FigmaPaint | null {
  switch (paint.type) {
    case "solid":
      return solidPaint(paint.color);
    case "linear-gradient":
      return {
        type: "GRADIENT_LINEAR",
        gradientStops: figmaGradientStops(paint.stops),
        gradientTransform: linearGradientTransform(
          paint.angleDegrees,
          bounds.width,
          bounds.height,
        ),
        opacity: 1,
      };
    case "radial-gradient":
      return {
        type: "GRADIENT_RADIAL",
        gradientStops: figmaGradientStops(paint.stops),
        gradientTransform: radialGradientTransform(paint),
        opacity: 1,
      };
    case "conic-gradient":
      return {
        type: "GRADIENT_ANGULAR",
        gradientStops: figmaGradientStops(paint.stops),
        gradientTransform: angularGradientTransform(paint),
        opacity: 1,
      };
    case "image": {
      const asset = context.assetsById.get(paint.assetId);
      if (!asset) {
        return null;
      }
      context.usedAssetIds.add(paint.assetId);
      context.fillAssetIds.add(paint.assetId);
      // SVG background images are rasterized by the plugin fallback path.
      const imagePaint: FigmaPaint = {
        type: "IMAGE",
        assetId: paint.assetId,
        scaleMode: mapScaleMode(paint.scaleMode),
        opacity: 1,
      };
      // Tile-size fact: an explicit pixel background-size determines each tile.
      // Figma TILE expresses it as scalingFactor (tile size / intrinsic image size).
      if (imagePaint.scaleMode === "TILE" && paint.tileSizePx !== undefined) {
        const naturalWidth = paint.naturalWidth ?? asset.naturalWidth;
        const naturalHeight = paint.naturalHeight ?? asset.naturalHeight;
        const factorX =
          paint.tileSizePx.width !== undefined && naturalWidth !== undefined && naturalWidth > 0
            ? paint.tileSizePx.width / naturalWidth
            : undefined;
        const factorY =
          paint.tileSizePx.height !== undefined && naturalHeight !== undefined && naturalHeight > 0
            ? paint.tileSizePx.height / naturalHeight
            : undefined;
        const factor = factorX ?? factorY;
        if (factor !== undefined && Number.isFinite(factor) && factor > 0) {
          imagePaint.scalingFactor = round2(factor);
        }
      }
      // Single-axis repeat fact (repeat-x/repeat-y). Figma TILE repeats on both
      // axes and cannot express this exactly, so warn instead of silently
      // approximating.
      if (paint.repeat === "repeat-x" || paint.repeat === "repeat-y") {
        addWarning(context, {
          code: "unsupported_paint",
          count: 1,
          detail: `single-axis background-repeat (${paint.repeat}) tiled on both axes`,
        });
      }
      return imagePaint;
    }
    default:
      return null;
  }
}

/**
 * CSS linear-gradient angle → Figma gradientTransform.
 *
 * CSS: 0deg points up, angles increase clockwise, y-axis points down.
 * The gradient line length is |w·sin θ| + |h·cos θ| centered in the box.
 * Figma: paints along the x-axis of gradient space; gradientTransform maps
 * normalized node space (0..1 both axes) into gradient space.
 */
export function linearGradientTransform(
  angleDegrees: number,
  width: number,
  height: number,
): FigmaGradientTransform {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const theta = (angleDegrees * Math.PI) / 180;
  const dirX = Math.sin(theta);
  const dirY = -Math.cos(theta); // CSS y-down
  const lineLength = Math.abs(w * dirX) + Math.abs(h * dirY);
  const half = lineLength / 2;
  // Start/end in pixel space, centered.
  const cx = w / 2;
  const cy = h / 2;
  const sx = (cx - dirX * half) / w;
  const sy = (cy - dirY * half) / h;
  const ex = (cx + dirX * half) / w;
  const ey = (cy + dirY * half) / h;
  return transformFromLine(sx, sy, ex, ey);
}

/** Build the affine transform mapping the segment (s→e) onto gradient x∈[0,1]. */
function transformFromLine(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): FigmaGradientTransform {
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) {
    return [
      [1, 0, 0],
      [0, 1, 0],
    ];
  }
  const a = dx / lengthSquared;
  const b = dy / lengthSquared;
  const c = -(sx * a + sy * b);
  // Perpendicular row keeps the mapping invertible.
  const pa = -b;
  const pb = a;
  const pc = -(sx * pa + sy * pb) + 0.5;
  return [
    [round4(a), round4(b), round4(c)],
    [round4(pa), round4(pb), round4(pc)],
  ];
}

function radialGradientTransform(paint: {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
}): FigmaGradientTransform {
  const rx = Math.max(0.01, paint.radiusX);
  const ry = Math.max(0.01, paint.radiusY);
  // Map so gradient space unit circle covers the ellipse.
  const a = 0.5 / rx;
  const d = 0.5 / ry;
  return [
    [round4(a), 0, round4(0.5 - paint.centerX * a)],
    [0, round4(d), round4(0.5 - paint.centerY * d)],
  ];
}

function angularGradientTransform(paint: {
  centerX: number;
  centerY: number;
  angleDegrees: number;
}): FigmaGradientTransform {
  const theta = ((paint.angleDegrees - 90) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [
    [round4(cos), round4(-sin), round4(paint.centerX - cos * paint.centerX + sin * paint.centerY)],
    [round4(sin), round4(cos), round4(paint.centerY - sin * paint.centerX - cos * paint.centerY)],
  ];
}

// ---------------------------------------------------------------------------
// Borders / radii / shadows
// ---------------------------------------------------------------------------

function convertBorders(borders: Borders | undefined): {
  strokes: FigmaPaint[];
  strokeWeight: number;
  strokeWeights?: { top: number; right: number; bottom: number; left: number };
} {
  if (!borders) {
    return { strokes: [], strokeWeight: 0 };
  }
  const sides = [borders.top, borders.right, borders.bottom, borders.left];
  const firstVisible = sides.find(
    (side) => side !== undefined && side.widthPx > 0 && side.style !== "none",
  );
  if (!firstVisible) {
    return { strokes: [], strokeWeight: 0 };
  }
  const strokes = [solidPaint(firstVisible.color)];
  if (borders.uniform) {
    return { strokes, strokeWeight: round2(firstVisible.widthPx) };
  }
  return {
    strokes,
    strokeWeight: round2(firstVisible.widthPx),
    strokeWeights: {
      top: round2(borders.top?.widthPx ?? 0),
      right: round2(borders.right?.widthPx ?? 0),
      bottom: round2(borders.bottom?.widthPx ?? 0),
      left: round2(borders.left?.widthPx ?? 0),
    },
  };
}

function buildMulticolorBorderSvgMarkup(
  borders: Borders | undefined,
  width: number,
  height: number,
  cornerRadii: CornerRadii | undefined,
): string | null {
  if (!borders || width <= 0 || height <= 0) {
    return null;
  }
  const sides = [borders.top, borders.right, borders.bottom, borders.left];
  const present = sides.filter(
    (side): side is NonNullable<(typeof sides)[number]> =>
      side !== undefined && side.widthPx > 0 && side.style !== "none",
  );
  if (present.length === 0 || present.some((side) => side.style !== "solid")) {
    return null;
  }
  const colorKeys = new Set(
    present.map((side) =>
      [side.color.r, side.color.g, side.color.b, side.color.a]
        .map((channel) => round4(channel))
        .join(":"),
    ),
  );
  if (colorKeys.size <= 1) {
    return null;
  }

  const top = Math.min(height, Math.max(0, borders.top?.widthPx ?? 0));
  const right = Math.min(width, Math.max(0, borders.right?.widthPx ?? 0));
  const bottom = Math.min(height, Math.max(0, borders.bottom?.widthPx ?? 0));
  const left = Math.min(width, Math.max(0, borders.left?.widthPx ?? 0));
  const innerLeft = Math.min(width, left);
  const innerRight = Math.max(innerLeft, width - right);
  const innerTop = Math.min(height, top);
  const innerBottom = Math.max(innerTop, height - bottom);
  const polygons: Array<{ points: string; color: RgbaColor | undefined }> = [
    {
      points: svgPoints([
        [0, 0],
        [width, 0],
        [innerRight, innerTop],
        [innerLeft, innerTop],
      ]),
      color: borders.top?.color,
    },
    {
      points: svgPoints([
        [width, 0],
        [width, height],
        [innerRight, innerBottom],
        [innerRight, innerTop],
      ]),
      color: borders.right?.color,
    },
    {
      points: svgPoints([
        [width, height],
        [0, height],
        [innerLeft, innerBottom],
        [innerRight, innerBottom],
      ]),
      color: borders.bottom?.color,
    },
    {
      points: svgPoints([
        [0, height],
        [0, 0],
        [innerLeft, innerTop],
        [innerLeft, innerBottom],
      ]),
      color: borders.left?.color,
    },
  ];
  const paintedPolygons = polygons
    .filter(({ color }, index) => {
      const side = sides[index];
      return side !== undefined && side.widthPx > 0 && side.style !== "none" && color?.a !== 0;
    })
    .map(
      ({ points, color }) =>
        `<polygon points="${points}" fill="${svgRgba(color!)}"/>`,
    )
    .join("");
  if (paintedPolygons.length === 0) {
    return null;
  }

  const roundedClip = roundedRectSvgPath(width, height, cornerRadii);
  const innerRoundedClip = innerRoundedRectSvgPath(
    width,
    height,
    cornerRadii,
    { top, right, bottom, left },
  );
  const body =
    roundedClip === null
      ? paintedPolygons
      : `<defs><clipPath id="border-clip"><path d="${roundedClip}${
          innerRoundedClip === null ? "" : ` ${innerRoundedClip}`
        }" fill-rule="evenodd" clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#border-clip)">${paintedPolygons}</g>`;
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="0 0 ${svgNumber(width)} ${svgNumber(height)}">${body}</svg>`;
  return isSafeSvgMarkup(markup) ? markup : null;
}

function svgPoints(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${svgNumber(x)},${svgNumber(y)}`).join(" ");
}

function svgNumber(value: number): string {
  return String(round4(value));
}

function svgRgba(color: RgbaColor): string {
  return `rgba(${Math.round(clamp01(color.r) * 255)},${Math.round(clamp01(color.g) * 255)},${Math.round(clamp01(color.b) * 255)},${svgNumber(clamp01(color.a))})`;
}

function roundedRectSvgPath(
  width: number,
  height: number,
  radii: CornerRadii | undefined,
): string | null {
  if (!radii) return null;
  const maxRadius = Math.min(width, height) / 2;
  const topLeft = Math.min(maxRadius, Math.max(0, radii.topLeft));
  const topRight = Math.min(maxRadius, Math.max(0, radii.topRight));
  const bottomRight = Math.min(maxRadius, Math.max(0, radii.bottomRight));
  const bottomLeft = Math.min(maxRadius, Math.max(0, radii.bottomLeft));
  if (topLeft + topRight + bottomRight + bottomLeft === 0) return null;
  return [
    `M ${svgNumber(topLeft)} 0`,
    `H ${svgNumber(width - topRight)}`,
    `Q ${svgNumber(width)} 0 ${svgNumber(width)} ${svgNumber(topRight)}`,
    `V ${svgNumber(height - bottomRight)}`,
    `Q ${svgNumber(width)} ${svgNumber(height)} ${svgNumber(width - bottomRight)} ${svgNumber(height)}`,
    `H ${svgNumber(bottomLeft)}`,
    `Q 0 ${svgNumber(height)} 0 ${svgNumber(height - bottomLeft)}`,
    `V ${svgNumber(topLeft)}`,
    `Q 0 0 ${svgNumber(topLeft)} 0`,
    "Z",
  ].join(" ");
}

function innerRoundedRectSvgPath(
  width: number,
  height: number,
  radii: CornerRadii | undefined,
  borders: { top: number; right: number; bottom: number; left: number },
): string | null {
  if (!radii) return null;
  const x = Math.min(width, Math.max(0, borders.left));
  const y = Math.min(height, Math.max(0, borders.top));
  const right = Math.max(x, width - Math.max(0, borders.right));
  const bottom = Math.max(y, height - Math.max(0, borders.bottom));
  const innerWidth = right - x;
  const innerHeight = bottom - y;
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const outerMax = Math.min(width, height) / 2;
  const outer = {
    topLeft: Math.min(outerMax, Math.max(0, radii.topLeft)),
    topRight: Math.min(outerMax, Math.max(0, radii.topRight)),
    bottomRight: Math.min(outerMax, Math.max(0, radii.bottomRight)),
    bottomLeft: Math.min(outerMax, Math.max(0, radii.bottomLeft)),
  };
  const maxRx = innerWidth / 2;
  const maxRy = innerHeight / 2;
  const corners = {
    topLeft: {
      x: Math.min(maxRx, Math.max(0, outer.topLeft - borders.left)),
      y: Math.min(maxRy, Math.max(0, outer.topLeft - borders.top)),
    },
    topRight: {
      x: Math.min(maxRx, Math.max(0, outer.topRight - borders.right)),
      y: Math.min(maxRy, Math.max(0, outer.topRight - borders.top)),
    },
    bottomRight: {
      x: Math.min(maxRx, Math.max(0, outer.bottomRight - borders.right)),
      y: Math.min(maxRy, Math.max(0, outer.bottomRight - borders.bottom)),
    },
    bottomLeft: {
      x: Math.min(maxRx, Math.max(0, outer.bottomLeft - borders.left)),
      y: Math.min(maxRy, Math.max(0, outer.bottomLeft - borders.bottom)),
    },
  };
  const tl = corners.topLeft;
  const tr = corners.topRight;
  const br = corners.bottomRight;
  const bl = corners.bottomLeft;
  return [
    `M ${svgNumber(x + tl.x)} ${svgNumber(y)}`,
    `H ${svgNumber(right - tr.x)}`,
    `Q ${svgNumber(right)} ${svgNumber(y)} ${svgNumber(right)} ${svgNumber(y + tr.y)}`,
    `V ${svgNumber(bottom - br.y)}`,
    `Q ${svgNumber(right)} ${svgNumber(bottom)} ${svgNumber(right - br.x)} ${svgNumber(bottom)}`,
    `H ${svgNumber(x + bl.x)}`,
    `Q ${svgNumber(x)} ${svgNumber(bottom)} ${svgNumber(x)} ${svgNumber(bottom - bl.y)}`,
    `V ${svgNumber(y + tl.y)}`,
    `Q ${svgNumber(x)} ${svgNumber(y)} ${svgNumber(x + tl.x)} ${svgNumber(y)}`,
    "Z",
  ].join(" ");
}

function applyCornerRadii(
  node: { cornerRadius?: number; cornerRadii?: CornerRadii },
  radii: CornerRadii | undefined,
): void {
  if (!radii) {
    return;
  }
  const { topLeft, topRight, bottomRight, bottomLeft } = radii;
  if (topLeft === topRight && topRight === bottomRight && bottomRight === bottomLeft) {
    if (topLeft > 0) {
      node.cornerRadius = round2(topLeft);
    }
    return;
  }
  node.cornerRadii = {
    topLeft: round2(topLeft),
    topRight: round2(topRight),
    bottomRight: round2(bottomRight),
    bottomLeft: round2(bottomLeft),
  };
}

function convertShadows(
  shadows: Shadow[] | undefined,
  blurPx: number | undefined,
  backdropBlurPx?: number,
  width = Number.POSITIVE_INFINITY,
  height = Number.POSITIVE_INFINITY,
): FigmaEffect[] {
  const effects: FigmaEffect[] = [];
  for (const shadow of shadows ?? []) {
    if (
      !shadow.inset &&
      shadow.spreadRadius < 0 &&
      (width + shadow.spreadRadius * 2 <= 0 || height + shadow.spreadRadius * 2 <= 0)
    ) {
      continue;
    }
    effects.push({
      type: shadow.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: shadow.color,
      offset: { x: round2(shadow.offsetX), y: round2(shadow.offsetY) },
      radius: Math.max(0, round2(shadow.blurRadius)),
      spread: round2(shadow.spreadRadius),
      visible: true,
      blendMode: "NORMAL",
    });
  }
  if (blurPx !== undefined && blurPx > 0) {
    // CSS blur(Npx) is a Gaussian with sigma=N; Figma's layer blur radius is
    // roughly 2*sigma, so double it to visually match the browser.
    effects.push({ type: "LAYER_BLUR", radius: round2(blurPx * 2), visible: true });
  }
  if (backdropBlurPx !== undefined && backdropBlurPx > 0) {
    // backdrop-filter blurs the content BEHIND the element (frosted glass),
    // which is exactly Figma's background blur — never a layer blur.
    effects.push({
      type: "BACKGROUND_BLUR",
      radius: round2(backdropBlurPx * 2),
      visible: true,
    });
  }
  return effects;
}

// ---------------------------------------------------------------------------
// Auto Layout
// ---------------------------------------------------------------------------

function convertAutoLayout(
  layout: FlexLayoutHint,
  padding: { top: number; right: number; bottom: number; left: number } | undefined,
): RenderPlanAutoLayout | null {
  if (layout.direction === "row-reverse" || layout.direction === "column-reverse") {
    // Reversed flows change visual order; absolute positioning is safer.
    return null;
  }
  const horizontal = layout.direction === "row";
  return {
    layoutMode: horizontal ? "HORIZONTAL" : "VERTICAL",
    itemSpacing: round2(horizontal ? layout.gapColumnPx : layout.gapRowPx),
    counterAxisSpacing: round2(horizontal ? layout.gapRowPx : layout.gapColumnPx),
    paddingTop: round2(padding?.top ?? 0),
    paddingRight: round2(padding?.right ?? 0),
    paddingBottom: round2(padding?.bottom ?? 0),
    paddingLeft: round2(padding?.left ?? 0),
    primaryAxisAlignItems: mapJustify(layout.justifyContent),
    counterAxisAlignItems: mapAlign(layout.alignItems),
    layoutWrap: layout.flexWrap === "wrap" ? "WRAP" : "NO_WRAP",
  };
}

function mapJustify(value: string): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
  switch (value) {
    case "center":
      return "CENTER";
    case "flex-end":
    case "end":
      return "MAX";
    case "space-between":
    case "space-around":
    case "space-evenly":
      return "SPACE_BETWEEN";
    default:
      return "MIN";
  }
}

function mapAlign(value: string): "MIN" | "CENTER" | "MAX" {
  switch (value) {
    case "center":
      return "CENTER";
    case "flex-end":
    case "end":
      return "MAX";
    default:
      return "MIN";
  }
}

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

const WEIGHT_NAMES: Array<[number, string]> = [
  [100, "Thin"],
  [200, "Extra Light"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semi Bold"],
  [700, "Bold"],
  [800, "Extra Bold"],
  [900, "Black"],
];

export function figmaFontStyle(weight: number, italic: boolean): string {
  let closest = WEIGHT_NAMES[3] as [number, string];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of WEIGHT_NAMES) {
    const distance = Math.abs(entry[0] - weight);
    if (distance < bestDistance) {
      bestDistance = distance;
      closest = entry;
    }
  }
  const base = closest[1];
  if (!italic) {
    return base;
  }
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

function registerFont(context: ConversionContext, family: string, style: string): void {
  const existing = context.fontKeys.get(family);
  if (existing) {
    existing.add(style);
  } else {
    context.fontKeys.set(family, new Set([style]));
  }
}

function mapTextAlign(align: TextStyle["textAlign"]): "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
  switch (align) {
    case "center":
      return "CENTER";
    case "right":
      return "RIGHT";
    case "justify":
      return "JUSTIFIED";
    default:
      return "LEFT";
  }
}

function mapDecoration(
  decoration: TextStyle["textDecoration"],
): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
  switch (decoration) {
    case "underline":
      return "UNDERLINE";
    case "line-through":
      return "STRIKETHROUGH";
    default:
      return "NONE";
  }
}

function mapTextCase(
  transform: TextStyle["textTransform"],
): "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" {
  // We bake the transform into characters (applyTextTransform), so the node
  // keeps ORIGINAL to avoid double-transforming in Figma.
  void transform;
  return "ORIGINAL";
}

function applyTextTransform(
  text: string,
  transform: TextStyle["textTransform"],
): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/\b\p{L}/gu, (char) => char.toUpperCase());
    default:
      return text;
  }
}

function mapScaleMode(mode: "fill" | "fit" | "crop" | "tile"): "FILL" | "FIT" | "CROP" | "TILE" {
  switch (mode) {
    case "fit":
      return "FIT";
    case "crop":
      return "CROP";
    case "tile":
      return "TILE";
    default:
      return "FILL";
  }
}

// ---------------------------------------------------------------------------
// Assets & fonts assembly
// ---------------------------------------------------------------------------

function buildAssets(context: ConversionContext): RenderPlanAsset[] {
  const assets: RenderPlanAsset[] = [];
  for (const assetId of context.usedAssetIds) {
    const asset = context.assetsById.get(assetId);
    if (!asset) {
      continue;
    }
    if (
      (asset.kind === "svg-inline" || asset.kind === "svg-image") &&
      isInlineSvgAsset(asset)
    ) {
      if (context.fillAssetIds.has(assetId) && svgMarkupFromAsset(asset) === null) {
        addWarning(context, {
          code: "asset_fetch_failed",
          count: 1,
          detail: `unsafe SVG fill asset ${assetId}`,
        });
        continue;
      }
      // An <svg> element carries markup on the node through svgMarkup and needs
      // no byte payload. SVG assets referenced by IMAGE fills (background SVGs
      // and tinted mask icons) have no svgMarkup channel; dropping them renders
      // blank output, so these assets must be retained.
      if (!context.fillAssetIds.has(assetId)) {
        continue;
      }
    }
    assets.push({
      assetId: asset.assetId,
      mediaType: asset.mediaType,
      ref: { kind: "capture", assetId: asset.assetId },
      ...(asset.naturalWidth !== undefined ? { naturalWidth: asset.naturalWidth } : {}),
      ...(asset.naturalHeight !== undefined ? { naturalHeight: asset.naturalHeight } : {}),
    });
  }
  return assets;
}

const FONT_FALLBACKS: Record<string, string> = {
  "sans-serif": "Inter",
  serif: "Georgia",
  monospace: "Roboto Mono",
};

function buildFontRequests(context: ConversionContext): RenderPlanFontRequest[] {
  const requests: RenderPlanFontRequest[] = [];
  for (const [family, styles] of context.fontKeys) {
    const generic = family.toLowerCase();
    const fallback = FONT_FALLBACKS[generic];
    requests.push({
      family: fallback ?? family,
      styles: Array.from(styles),
      fallbackFamily: generic === "monospace" ? "Roboto Mono" : "Inter",
    });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
