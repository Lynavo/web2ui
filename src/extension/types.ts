import type { CaptureOptions } from "../core/contracts/capture-options.js";
import type { CaptureDocument, PageRect } from "../core/contracts/capture.js";
import type { ExtensionState } from "./state-machine.js";

export type { CaptureOptions };

export const CAPTURE_MODES = ["visible-area", "full-page"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export interface CaptureRunIdentity {
  runId: string;
  tabId: number;
  documentId: string;
}

export const POPUP_MESSAGE_TYPES = [
  "get-state",
  "get-active-tab-viewport",
  "start-capture",
  "prepare-clipboard",
  "clear-result",
] as const;

export type PopupMessage =
  | { type: "get-state" }
  | { type: "get-active-tab-viewport" }
  | { type: "start-capture"; mode: CaptureMode; options?: CaptureOptions }
  | { type: "prepare-clipboard" }
  | { type: "clear-result" };

export const CONTENT_MESSAGE_TYPES = [
  "capture-progress",
  "capture-done",
  "capture-error",
  "capture-element-screenshot",
  "fetch-asset",
] as const;

export type ContentMessage = CaptureRunIdentity &
  (
    | { type: "capture-progress"; progress: number; label: string }
    | { type: "capture-done"; document: CaptureDocument }
    | { type: "capture-error"; code: string }
    | {
        type: "capture-element-screenshot";
        rect: PageRect;
        transparentBackground?: boolean;
      }
    | { type: "fetch-asset"; url: string }
  );

export interface RunCaptureCommand extends CaptureRunIdentity {
  type: "run-capture";
  mode: CaptureMode;
  options: CaptureOptions;
}

export interface FetchAssetResponse {
  ok: boolean;
  bytes?: ArrayBuffer;
  contentType?: string;
}

export interface ElementScreenshotResponse {
  ok: boolean;
  dataUrl?: string;
}

export interface FigmaClipboardPayload {
  svg: string;
  html: string;
  text: string;
}

export type PopupResponse =
  | { ok: true; state: ExtensionState }
  | {
      ok: true;
      viewport: {
        widthPx: number;
        heightPx: number;
        deviceScaleFactor: number;
      } | null;
    }
  | { ok: true; payload: FigmaClipboardPayload }
  | { ok: true }
  | { ok: false; code: string };

export function isPopupMessage(value: unknown): value is PopupMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "get-state":
    case "get-active-tab-viewport":
    case "prepare-clipboard":
    case "clear-result":
      return hasOnlyKeys(value, ["type"]);
    case "start-capture":
      return (
        hasOnlyKeys(value, ["type", "mode", "options"]) &&
        CAPTURE_MODES.includes(value.mode as CaptureMode) &&
        (value.options === undefined || isCaptureOptions(value.options))
      );
    default:
      return false;
  }
}

function isCaptureOptions(value: unknown): value is CaptureOptions {
  if (!isRecord(value) || !hasOnlyKeys(value, ["viewports", "themes"])) return false;
  if (!Array.isArray(value.viewports) || value.viewports.length !== 1) return false;
  if (!Array.isArray(value.themes) || value.themes.length !== 1) return false;
  const viewport = value.viewports[0];
  const theme = value.themes[0];
  if (!isRecord(viewport) || !hasOnlyKeys(viewport, ["id", "label", "widthPx", "source"])) {
    return false;
  }
  if (
    typeof viewport.id !== "string" ||
    typeof viewport.label !== "string" ||
    (viewport.source !== "browser" && viewport.source !== "preset")
  ) {
    return false;
  }
  if (
    viewport.widthPx !== null &&
    (!Number.isInteger(viewport.widthPx) || Number(viewport.widthPx) < 1)
  ) {
    return false;
  }
  if (!isRecord(theme) || !hasOnlyKeys(theme, ["id", "label", "source"])) return false;
  return (
    (theme.id === "browser" || theme.id === "light" || theme.id === "dark") &&
    typeof theme.label === "string" &&
    (theme.source === "browser" || theme.source === "forced")
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
