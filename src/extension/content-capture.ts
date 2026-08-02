import type {
  InPageExtractionResult,
  InPageExtractorOptions,
} from "../core/capture/in-page-extractor.js";
import type {
  CaptureAsset,
  CaptureDocument,
  PageRect,
  CaptureViewport,
  CaptureWarning,
} from "../core/contracts/capture.js";
import { CAPTURE_CONTRACT_VERSION } from "../core/contracts/capture.js";
import { markUnresolvedImageNodes } from "./content-assets.js";
import type { RunCaptureCommand } from "./types.js";

const MAX_CAPTURE_NODES = 8_000;

export interface ContentCaptureDependencies {
  now: () => number;
  nextCaptureId: () => `cap_${string}`;
  viewport: () => CaptureViewport;
  safeSourceLabel: () => string;
  hideConsent: () => number;
  restoreConsent: () => void;
  stabilizeFullPage: () => Promise<{ width: number; height: number }>;
  settlePage: () => Promise<void>;
  viewportClip: () => PageRect;
  extract: (
    options: InPageExtractorOptions,
  ) => InPageExtractionResult | Promise<InPageExtractionResult>;
  resolveAssets: (
    extraction: InPageExtractionResult,
    command: RunCaptureCommand,
  ) => Promise<{ assets: CaptureAsset[]; warnings: CaptureWarning[] }>;
  resolveFallbacks: (
    root: CaptureDocument["root"],
    assets: CaptureAsset[],
    warnings: CaptureWarning[],
    command: RunCaptureCommand,
  ) => Promise<void>;
  cleanupMarkers: () => void;
  restoreScroll: () => void;
  assertActive: (command: RunCaptureCommand) => void;
  reportProgress: (
    command: RunCaptureCommand,
    progress: number,
    label: string,
  ) => Promise<void>;
}

export async function executeContentCapture(
  command: RunCaptureCommand,
  dependencies: ContentCaptureDependencies,
): Promise<CaptureDocument> {
  const startedAt = dependencies.now();
  const hiddenConsentCount = dependencies.hideConsent();

  try {
    await dependencies.reportProgress(command, 0.08, "Preparing page");
    dependencies.assertActive(command);

    let capturePageSize: { width: number; height: number } | undefined;
    if (command.mode === "full-page") {
      capturePageSize = await dependencies.stabilizeFullPage();
      dependencies.assertActive(command);
    }
    await dependencies.settlePage();
    dependencies.assertActive(command);

    await dependencies.reportProgress(command, 0.35, "Reading page structure");
    dependencies.assertActive(command);
    const extraction = await dependencies.extract({
      maxNodes: MAX_CAPTURE_NODES,
      captureTextFallbacks: true,
      ...(command.mode === "full-page"
        ? { captureVirtualizedContent: true, capturePageSize: capturePageSize! }
        : { viewportClip: dependencies.viewportClip() }),
    });
    dependencies.assertActive(command);

    await dependencies.reportProgress(command, 0.6, "Preparing page assets");
    dependencies.assertActive(command);
    const resolved = await dependencies.resolveAssets(extraction, command);
    dependencies.assertActive(command);
    markUnresolvedImageNodes(extraction.root, resolved.assets);

    const warnings: CaptureWarning[] = [
      ...extraction.warnings,
      ...resolved.warnings,
      ...(hiddenConsentCount > 0
        ? [{ code: "cookie_consent_hidden" as const, count: hiddenConsentCount }]
        : []),
    ];

    await dependencies.resolveFallbacks(
      extraction.root,
      resolved.assets,
      warnings,
      command,
    );
    dependencies.assertActive(command);

    await dependencies.reportProgress(command, 0.92, "Finalizing local capture");
    dependencies.assertActive(command);
    const viewport = dependencies.viewport();
    const capturedAt = dependencies.now();

    return {
      schemaVersion: CAPTURE_CONTRACT_VERSION,
      captureId: dependencies.nextCaptureId(),
      sourceType: "chrome_capture",
      capturedAt: new Date(capturedAt).toISOString(),
      safeSourceLabel: dependencies.safeSourceLabel(),
      viewport,
      page: {
        widthPx: extraction.pageWidth,
        heightPx: extraction.pageHeight,
        fullPage: command.mode === "full-page",
      },
      pageBackground: extraction.pageBackground,
      paintOrderVersion: 1,
      environment: {
        requestedViewports: command.options.viewports,
        requestedThemes: command.options.themes,
        resolvedViewport: viewport,
        resolvedColorScheme: null,
      },
      root: extraction.root,
      assets: resolved.assets,
      fonts: extraction.fonts,
      warnings,
      stats: {
        nodeCount: extraction.nodeCount,
        textNodeCount: extraction.textNodeCount,
        imageNodeCount: extraction.imageNodeCount,
        assetByteTotal: resolved.assets.reduce((total, asset) => total + asset.byteSize, 0),
        captureDurationMs: Math.max(0, dependencies.now() - startedAt),
      },
    };
  } finally {
    try {
      dependencies.cleanupMarkers();
    } finally {
      try {
        dependencies.restoreConsent();
      } finally {
        dependencies.restoreScroll();
      }
    }
  }
}
