import type { CaptureOptions } from "../core/contracts/capture-options.js";
import { isCaptureDocument } from "../core/contracts/capture.js";
import type {
  CaptureDocument,
  CaptureWarning,
} from "../core/contracts/capture.js";
import type { RenderPlan } from "../core/contracts/render-plan.js";
import {
  RenderPlanTooLargeError,
  type StoredRenderPlan,
} from "./plan-store.js";
import {
  initialExtensionState,
  reduceExtensionState,
  type CaptureMode,
  type CaptureRunIdentity,
  type ExtensionErrorCode,
  type ExtensionState,
} from "./state-machine.js";
import type { ContentMessage, FigmaClipboardPayload, RunCaptureCommand } from "./types.js";

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  viewports: [{ id: "browser", label: "Browser", widthPx: null, source: "browser" }],
  themes: [{ id: "browser", label: "Browser", source: "browser" }],
};

export function countVisualWarningDetails(warnings: readonly CaptureWarning[]): number {
  const nodeIds = new Set<string>();
  let unscopedCount = 0;
  for (const warning of warnings) {
    if (warning.nodeId !== undefined) {
      nodeIds.add(warning.nodeId);
    } else {
      unscopedCount += warning.count;
    }
  }
  return nodeIds.size + unscopedCount;
}

export interface LocalPlanStore {
  put(
    plan: RenderPlan,
    identity: CaptureRunIdentity & { mode: CaptureMode },
  ): Promise<StoredRenderPlan>;
  getCurrent(): Promise<StoredRenderPlan | null>;
  clear(): Promise<void>;
  cleanupExpired(): Promise<void>;
}

export interface BackgroundPlatform {
  now(): number;
  nextRunId(): string;
  getActiveTab(): Promise<{ id: number; url: string }>;
  measureViewport(
    tabId: number,
  ): Promise<{ width: number; height: number; deviceScaleFactor: number }>;
  getCurrentDocumentId(tabId: number): Promise<string | null>;
  attachDebugger(tabId: number): Promise<void>;
  sendDebuggerCommand(
    tabId: number,
    method:
      | "Emulation.setDeviceMetricsOverride"
      | "Emulation.clearDeviceMetricsOverride"
      | "Emulation.setEmulatedMedia"
      | "Emulation.setDefaultBackgroundColorOverride"
      | "Page.captureScreenshot",
    parameters: Record<string, unknown>,
  ): Promise<unknown>;
  detachDebugger(tabId: number): Promise<void>;
  injectContent(tabId: number): Promise<{ documentId: string }>;
  sendCaptureCommand(
    tabId: number,
    documentId: string,
    command: RunCaptureCommand,
  ): Promise<void>;
  saveState(state: ExtensionState): Promise<void>;
}

interface DebuggerSession {
  tabId: number;
  runId: string;
  mode: CaptureMode;
  attached: boolean;
  metricsApplied: boolean;
  mediaApplied: boolean;
  identity?: CaptureRunIdentity;
}

export class BackgroundController {
  readonly #platform: BackgroundPlatform;
  readonly #store: LocalPlanStore;
  readonly #convert: (document: CaptureDocument) => RenderPlan;
  readonly #clipboard: (
    plan: RenderPlan,
  ) => FigmaClipboardPayload | Promise<FigmaClipboardPayload>;
  #state: ExtensionState = initialExtensionState();
  #session: DebuggerSession | null = null;

  constructor(options: {
    platform: BackgroundPlatform;
    store: LocalPlanStore;
    convert: (document: CaptureDocument) => RenderPlan;
    clipboard: (plan: RenderPlan) => FigmaClipboardPayload | Promise<FigmaClipboardPayload>;
  }) {
    this.#platform = options.platform;
    this.#store = options.store;
    this.#convert = options.convert;
    this.#clipboard = options.clipboard;
  }

  getState(): ExtensionState {
    return this.#state;
  }

  async initialize(): Promise<void> {
    await this.#store.cleanupExpired();
    const stored = await this.#store.getCurrent();
    if (!stored) {
      await this.#setState(initialExtensionState());
      return;
    }
    await this.#setState({
      status: "ready",
      runId: stored.runId,
      tabId: stored.tabId,
      documentId: stored.documentId,
      mode: stored.mode,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      warningCount: countVisualWarningDetails(stored.plan.warnings),
    });
  }

  async startCapture(mode: CaptureMode, options: CaptureOptions): Promise<ExtensionState> {
    await this.#cleanupDebugger();
    await this.#store.clear();
    await this.#setState(initialExtensionState());

    const tab = await this.#platform.getActiveTab();
    if (!isHttpUrl(tab.url)) {
      await this.#setState({
        status: "error",
        code: "unsupported-page",
        message: "Open an HTTP(S) page before capturing.",
      });
      throw new Error("Unsupported page");
    }

    const runId = this.#platform.nextRunId();
    const session: DebuggerSession = {
      tabId: tab.id,
      runId,
      mode,
      attached: false,
      metricsApplied: false,
      mediaApplied: false,
    };
    this.#session = session;

    try {
      const viewport = await this.#platform.measureViewport(tab.id);
      await this.#platform.attachDebugger(tab.id);
      session.attached = true;

      const selectedViewport = options.viewports[0] ?? DEFAULT_CAPTURE_OPTIONS.viewports[0]!;
      // Lock the measured browser viewport as well as explicit presets. A
      // clipped Page.captureScreenshot can otherwise mutate Chromium's layout
      // viewport between fallback regions and capture pixels after reflow.
      await this.#platform.sendDebuggerCommand(tab.id, "Emulation.setDeviceMetricsOverride", {
        width:
          selectedViewport.source === "preset" && selectedViewport.widthPx !== null
            ? selectedViewport.widthPx
            : viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
      });
      session.metricsApplied = true;

      const selectedTheme = options.themes[0] ?? DEFAULT_CAPTURE_OPTIONS.themes[0]!;
      if (selectedTheme.source === "forced") {
        await this.#platform.sendDebuggerCommand(tab.id, "Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: selectedTheme.id }],
        });
        session.mediaApplied = true;
      }

      const injection = await this.#platform.injectContent(tab.id);
      const identity: CaptureRunIdentity = {
        runId,
        tabId: tab.id,
        documentId: injection.documentId,
      };
      session.identity = identity;
      await this.#setState(
        reduceExtensionState(this.#state, {
          type: "start-capture",
          identity,
          mode,
          startedAt: this.#platform.now(),
        }),
      );
      await this.#platform.sendCaptureCommand(tab.id, injection.documentId, {
        type: "run-capture",
        ...identity,
        mode,
        options,
      });
      return this.#state;
    } catch (error) {
      if (this.#session === session) {
        await this.#failSession("permission-denied", "Chrome could not start this capture.");
      }
      throw error;
    }
  }

  async handleContentMessage(
    message: ContentMessage,
    sender: { tabId: number; documentId: string },
  ): Promise<void> {
    if (!this.acceptsContentIdentity(message, sender)) return;
    const identity = identityFrom(message);

    switch (message.type) {
      case "capture-progress":
        await this.#setState(
          reduceExtensionState(this.#state, {
            type: "capture-progress",
            identity,
            progress: message.progress,
            label: message.label,
          }),
        );
        return;
      case "capture-error":
        await this.#failSession("capture-failed", "The page could not be captured.");
        return;
      case "capture-done":
        await this.#completeCapture(message.document, identity);
        return;
      case "capture-element-screenshot":
      case "fetch-asset":
        return;
    }
  }

  acceptsContentIdentity(
    message: Pick<ContentMessage, "runId" | "tabId" | "documentId">,
    sender: { tabId: number; documentId: string },
  ): boolean {
    const identity = this.#session?.identity;
    return (
      identity !== undefined &&
      message.runId === identity.runId &&
      message.tabId === identity.tabId &&
      message.documentId === identity.documentId &&
      sender.tabId === identity.tabId &&
      sender.documentId === identity.documentId
    );
  }

  async prepareClipboard(): Promise<FigmaClipboardPayload> {
    if (this.#state.status !== "ready") throw new Error("No local capture is ready");
    const identity = identityFrom(this.#state);
    const stored = await this.#store.getCurrent();
    if (!stored || stored.runId !== identity.runId) throw new Error("Local capture expired");

    await this.#setState(
      reduceExtensionState(this.#state, { type: "prepare-clipboard", identity }),
    );
    try {
      const payload = await this.#clipboard(stored.plan);
      await this.#setState(
        reduceExtensionState(this.#state, { type: "clipboard-complete", identity }),
      );
      return payload;
    } catch (error) {
      await this.#setState(
        reduceExtensionState(this.#state, {
          type: "clipboard-failed",
          identity,
          message: "Clipboard payload could not be prepared.",
        }),
      );
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.#cleanupDebugger();
    await this.#store.clear();
    await this.#setState(initialExtensionState());
  }

  async failForPageChange(tabId: number, removed: boolean): Promise<void> {
    if (this.#session?.tabId !== tabId) return;
    await this.#failSession(
      removed ? "tab-closed" : "page-changed",
      removed ? "The captured tab was closed." : "The page changed during capture.",
    );
  }

  async failIfCaptureDocumentChanged(tabId: number): Promise<void> {
    const identity = this.#session?.identity;
    if (!identity || identity.tabId !== tabId) return;

    const documentId = await this.#platform
      .getCurrentDocumentId(tabId)
      .catch(() => null);
    const currentIdentity = this.#session?.identity;
    if (
      !currentIdentity ||
      currentIdentity.runId !== identity.runId ||
      currentIdentity.tabId !== identity.tabId ||
      currentIdentity.documentId !== identity.documentId
    ) {
      return;
    }
    if (documentId === identity.documentId) return;
    await this.failForPageChange(tabId, false);
  }

  getActiveTabId(): number | null {
    return this.#session?.tabId ?? null;
  }

  async #completeCapture(document: CaptureDocument, identity: CaptureRunIdentity): Promise<void> {
    if (!isCaptureDocument(document)) {
      await this.#failSession("invalid-capture", "The page returned invalid capture data.");
      return;
    }
    await this.#setState(
      reduceExtensionState(this.#state, { type: "capture-complete", identity }),
    );

    let plan: RenderPlan;
    try {
      plan = this.#convert(document);
    } catch {
      await this.#failSession(
        "conversion-failed",
        "A page structure could not be converted locally.",
      );
      return;
    }

    try {
      const stored = await this.#store.put(plan, {
        ...identity,
        mode: this.#session?.mode ?? "visible-area",
      });
      if (!this.acceptsContentIdentity(identity, {
        tabId: identity.tabId,
        documentId: identity.documentId,
      })) {
        const current = await this.#store.getCurrent();
        if (current?.runId === identity.runId) await this.#store.clear();
        return;
      }
      await this.#setState(
        reduceExtensionState(this.#state, {
          type: "conversion-complete",
          identity,
          createdAt: stored.createdAt,
          expiresAt: stored.expiresAt,
          warningCount: countVisualWarningDetails(plan.warnings),
        }),
      );
      await this.#cleanupDebugger();
    } catch (error) {
      if (error instanceof RenderPlanTooLargeError) {
        await this.#failSession(
          "plan-too-large",
          `The converted result is ${formatMegabytes(error.actualBytes)}, above the ${formatMegabytes(error.maxBytes)} local limit.`,
        );
        return;
      }
      await this.#failSession(
        "storage-failed",
        "Chrome could not save the converted result locally.",
      );
    }
  }

  async #failSession(code: ExtensionErrorCode, message: string): Promise<void> {
    const identity = this.#session?.identity;
    if (identity && (this.#state.status === "capturing" || this.#state.status === "converting")) {
      await this.#setState(
        reduceExtensionState(this.#state, { type: "run-failed", identity, code, message }),
      );
    } else {
      await this.#setState({ status: "error", code, message });
    }
    await this.#store.clear();
    await this.#cleanupDebugger();
  }

  async #cleanupDebugger(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    if (session.metricsApplied) {
      await this.#platform
        .sendDebuggerCommand(session.tabId, "Emulation.clearDeviceMetricsOverride", {})
        .catch(() => undefined);
    }
    if (session.mediaApplied) {
      await this.#platform
        .sendDebuggerCommand(session.tabId, "Emulation.setEmulatedMedia", { features: [] })
        .catch(() => undefined);
    }
    if (session.attached) {
      await this.#platform.detachDebugger(session.tabId).catch(() => undefined);
    }
  }

  async #setState(state: ExtensionState): Promise<void> {
    this.#state = state;
    await this.#platform.saveState(state);
  }
}

function identityFrom(value: CaptureRunIdentity): CaptureRunIdentity {
  return { runId: value.runId, tabId: value.tabId, documentId: value.documentId };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
