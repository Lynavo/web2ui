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
  isExtensionState,
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
  get(tabId: number): Promise<StoredRenderPlan | null>;
  getAll(): Promise<StoredRenderPlan[]>;
  clear(tabId: number): Promise<void>;
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
  loadStates(): Promise<unknown>;
  saveStates(states: Record<string, ExtensionState>): Promise<void>;
  scheduleResultExpiry(when: number): Promise<void>;
  clearResultExpiry(): Promise<void>;
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
  readonly #states = new Map<number, ExtensionState>();
  readonly #sessions = new Map<number, DebuggerSession>();
  #stateWrite: Promise<void> = Promise.resolve();
  #resultLock: Promise<void> = Promise.resolve();

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

  getState(tabId?: number): ExtensionState {
    const resolvedTabId = this.#resolveTabId(tabId);
    return resolvedTabId === null
      ? initialExtensionState()
      : this.#states.get(resolvedTabId) ?? initialExtensionState();
  }

  async initialize(): Promise<void> {
    await this.#store.cleanupExpired();
    await this.#restorePersistedStates();
    const storedPlans = await this.#store.getAll();
    const plansByTab = new Map(storedPlans.map((stored) => [stored.tabId, stored]));
    for (const [tabId, state] of this.#states) {
      if (
        (state.status === "ready" || state.status === "preparing-clipboard") &&
        plansByTab.get(tabId)?.runId !== state.runId
      ) {
        this.#states.delete(tabId);
      }
    }
    for (const stored of storedPlans) {
      const restored = this.#states.get(stored.tabId);
      this.#states.set(stored.tabId, {
        status: "ready",
        runId: stored.runId,
        tabId: stored.tabId,
        documentId: stored.documentId,
        mode: stored.mode,
        createdAt: stored.createdAt,
        expiresAt: stored.expiresAt,
        warningCount: countVisualWarningDetails(stored.plan.warnings),
        ...(restored?.status === "ready" && restored.runId === stored.runId
          ? {
              copyResult: restored.copyResult,
              copyError: restored.copyError,
            }
          : {}),
      });
    }
    await this.#scheduleNextResultExpiry(storedPlans);
    await this.#persistStates();
  }

  async startCapture(mode: CaptureMode, options: CaptureOptions): Promise<ExtensionState> {
    const tab = await this.#platform.getActiveTab();
    if (!isHttpUrl(tab.url)) {
      await this.#cleanupDebugger(tab.id);
      await this.#setState(tab.id, {
        status: "error",
        code: "unsupported-page",
        message: "Open an HTTP(S) page before capturing.",
      });
      throw new Error("Unsupported page");
    }

    await this.#cleanupDebugger(tab.id);
    await this.#clearStoredResultForNewCapture(tab.id);
    await this.#setState(tab.id, initialExtensionState());

    const runId = this.#platform.nextRunId();
    const session: DebuggerSession = {
      tabId: tab.id,
      runId,
      mode,
      attached: false,
      metricsApplied: false,
      mediaApplied: false,
    };
    this.#sessions.set(tab.id, session);

    try {
      const viewport = await this.#platform.measureViewport(tab.id);
      await this.#platform.attachDebugger(tab.id);
      session.attached = true;

      const selectedViewport = options.viewports[0] ?? DEFAULT_CAPTURE_OPTIONS.viewports[0]!;
      if (selectedViewport.source === "preset" && selectedViewport.widthPx !== null) {
        await this.#platform.sendDebuggerCommand(tab.id, "Emulation.setDeviceMetricsOverride", {
          width: selectedViewport.widthPx,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
          mobile: false,
        });
        session.metricsApplied = true;
      }

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
        tab.id,
        reduceExtensionState(this.getState(tab.id), {
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
      return this.getState(tab.id);
    } catch (error) {
      if (this.#sessions.get(tab.id) === session) {
        await this.#failSession(
          tab.id,
          "permission-denied",
          "Chrome could not start this capture.",
          session.runId,
        );
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
          identity.tabId,
          reduceExtensionState(this.getState(identity.tabId), {
            type: "capture-progress",
            identity,
            progress: message.progress,
            label: message.label,
          }),
        );
        return;
      case "capture-error":
        await this.#failSession(
          identity.tabId,
          "capture-failed",
          "The page could not be captured.",
          identity.runId,
        );
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
    const identity = this.#sessions.get(message.tabId)?.identity;
    return (
      identity !== undefined &&
      message.runId === identity.runId &&
      message.tabId === identity.tabId &&
      message.documentId === identity.documentId &&
      sender.tabId === identity.tabId &&
      sender.documentId === identity.documentId
    );
  }

  async prepareClipboard(tabId?: number): Promise<FigmaClipboardPayload> {
    const resolvedTabId = this.#resolveTabId(tabId);
    if (resolvedTabId === null) throw new Error("No local capture is ready");
    const state = this.getState(resolvedTabId);
    if (state.status !== "ready") throw new Error("No local capture is ready");
    const identity = identityFrom(state);
    const stored = await this.#store.get(resolvedTabId);
    if (
      !stored ||
      stored.runId !== identity.runId ||
      stored.tabId !== resolvedTabId
    ) {
      throw new Error("Local capture expired");
    }

    await this.#setState(
      resolvedTabId,
      reduceExtensionState(state, { type: "prepare-clipboard", identity }),
    );
    try {
      const payload = await this.#clipboard(stored.plan);
      const latest = await this.#store.get(resolvedTabId);
      if (latest?.runId !== identity.runId || latest.tabId !== resolvedTabId) {
        throw new Error("Local capture was replaced");
      }
      await this.#setState(
        resolvedTabId,
        reduceExtensionState(this.getState(resolvedTabId), {
          type: "clipboard-complete",
          identity,
        }),
      );
      return payload;
    } catch (error) {
      const current = this.getState(resolvedTabId);
      if (current.status === "preparing-clipboard") {
        await this.#setState(
          resolvedTabId,
          reduceExtensionState(current, {
            type: "clipboard-failed",
            identity,
            message: "Clipboard payload could not be prepared.",
          }),
        );
      }
      throw error;
    }
  }

  async clear(tabId?: number): Promise<void> {
    const resolvedTabId = this.#resolveTabId(tabId);
    if (resolvedTabId === null) return;
    await this.#cleanupDebugger(resolvedTabId);
    await this.#withResultLock(async () => {
      await this.#store.clear(resolvedTabId);
      await this.#scheduleNextResultExpiry();
    });
    await this.#setState(resolvedTabId, initialExtensionState());
  }

  async handleResultExpiry(): Promise<void> {
    await this.#withResultLock(async () => {
      await this.#store.cleanupExpired();
      const storedPlans = await this.#store.getAll();
      const plansByTab = new Map(storedPlans.map((stored) => [stored.tabId, stored]));
      let changed = false;
      for (const [tabId, state] of this.#states) {
        if (
          (state.status === "ready" || state.status === "preparing-clipboard") &&
          plansByTab.get(tabId)?.runId !== state.runId
        ) {
          this.#states.delete(tabId);
          changed = true;
        }
      }
      await this.#scheduleNextResultExpiry(storedPlans);
      if (changed) await this.#persistStates();
    });
  }

  async handlePageChange(tabId: number): Promise<void> {
    if (this.#sessions.has(tabId)) {
      await this.failIfCaptureDocumentChanged(tabId);
      return;
    }
    if (this.getState(tabId).status !== "idle") await this.clear(tabId);
  }

  async removeTab(tabId: number): Promise<void> {
    await this.#cleanupDebugger(tabId);
    await this.#withResultLock(async () => {
      await this.#store.clear(tabId);
      await this.#scheduleNextResultExpiry();
    });
    await this.#setState(tabId, initialExtensionState());
  }

  async failForPageChange(tabId: number, removed: boolean): Promise<void> {
    if (!this.#sessions.has(tabId)) return;
    if (removed) {
      await this.removeTab(tabId);
      return;
    }
    await this.#failSession(
      tabId,
      removed ? "tab-closed" : "page-changed",
      removed ? "The captured tab was closed." : "The page changed during capture.",
      this.#sessions.get(tabId)?.runId,
    );
  }

  async failIfCaptureDocumentChanged(tabId: number): Promise<void> {
    const identity = this.#sessions.get(tabId)?.identity;
    if (!identity || identity.tabId !== tabId) return;

    const documentId = await this.#platform
      .getCurrentDocumentId(tabId)
      .catch(() => null);
    const currentIdentity = this.#sessions.get(tabId)?.identity;
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
    return this.#sessions.size === 1 ? this.#sessions.keys().next().value ?? null : null;
  }

  hasActiveSession(tabId: number): boolean {
    return this.#sessions.has(tabId);
  }

  async #completeCapture(document: CaptureDocument, identity: CaptureRunIdentity): Promise<void> {
    if (!isCaptureDocument(document)) {
      await this.#failSession(
        identity.tabId,
        "invalid-capture",
        "The page returned invalid capture data.",
        identity.runId,
      );
      return;
    }
    await this.#setState(
      identity.tabId,
      reduceExtensionState(this.getState(identity.tabId), {
        type: "capture-complete",
        identity,
      }),
    );

    let plan: RenderPlan;
    try {
      plan = this.#convert(document);
    } catch {
      await this.#failSession(
        identity.tabId,
        "conversion-failed",
        "A page structure could not be converted locally.",
        identity.runId,
      );
      return;
    }

    try {
      const session = this.#sessions.get(identity.tabId);
      const mode = session?.mode ?? "visible-area";
      await this.#withResultLock(async () => {
        if (!this.#acceptsIdentity(identity)) return;
        const stored = await this.#store.put(plan, { ...identity, mode });
        if (!this.#acceptsIdentity(identity)) {
          const current = await this.#store.get(identity.tabId);
          if (current?.runId === identity.runId) {
            await this.#store.clear(identity.tabId);
            await this.#scheduleNextResultExpiry();
          }
          return;
        }
        await this.#setState(
          identity.tabId,
          reduceExtensionState(this.getState(identity.tabId), {
            type: "conversion-complete",
            identity,
            createdAt: stored.createdAt,
            expiresAt: stored.expiresAt,
            warningCount: countVisualWarningDetails(plan.warnings),
          }),
        );
        await this.#scheduleNextResultExpiry();
      });
      await this.#cleanupDebugger(identity.tabId, identity.runId);
    } catch (error) {
      if (error instanceof RenderPlanTooLargeError) {
        await this.#failSession(
          identity.tabId,
          "plan-too-large",
          `The converted result is ${formatMegabytes(error.actualBytes)}, above the ${formatMegabytes(error.maxBytes)} local limit.`,
          identity.runId,
        );
        return;
      }
      await this.#failSession(
        identity.tabId,
        "storage-failed",
        "Chrome could not save the converted result locally.",
        identity.runId,
      );
    }
  }

  async #failSession(
    tabId: number,
    code: ExtensionErrorCode,
    message: string,
    expectedRunId?: string,
  ): Promise<void> {
    const session = this.#sessions.get(tabId);
    if (expectedRunId !== undefined && session?.runId !== expectedRunId) return;
    const identity = session?.identity;
    const state = this.getState(tabId);
    if (identity && (state.status === "capturing" || state.status === "converting")) {
      await this.#setState(
        tabId,
        reduceExtensionState(state, { type: "run-failed", identity, code, message }),
      );
    } else {
      await this.#setState(tabId, { status: "error", code, message });
    }
    await this.#cleanupDebugger(tabId, expectedRunId ?? session?.runId);
  }

  async #cleanupDebugger(tabId: number, expectedRunId?: string): Promise<void> {
    const session = this.#sessions.get(tabId);
    if (!session) return;
    if (expectedRunId !== undefined && session.runId !== expectedRunId) return;
    this.#sessions.delete(tabId);
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

  async #setState(tabId: number, state: ExtensionState): Promise<void> {
    if (state.status === "idle") this.#states.delete(tabId);
    else this.#states.set(tabId, state);
    await this.#persistStates();
  }

  async #restorePersistedStates(): Promise<void> {
    const raw = await this.#platform.loadStates().catch(() => null);
    if (!isRecord(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || !isExtensionState(value) || value.status === "idle") continue;
      if ("tabId" in value && value.tabId !== tabId) continue;
      if (
        value.status === "capturing" ||
        value.status === "converting"
      ) {
        this.#states.set(tabId, value);
        this.#sessions.set(tabId, {
          tabId,
          runId: value.runId,
          mode: value.mode,
          attached: true,
          metricsApplied: true,
          mediaApplied: true,
          identity: identityFrom(value),
        });
      } else {
        this.#states.set(tabId, value);
      }
    }
  }

  async #persistStates(): Promise<void> {
    const snapshot = Object.fromEntries(
      [...this.#states.entries()].map(([tabId, state]) => [String(tabId), state]),
    );
    const write = this.#stateWrite.then(() => this.#platform.saveStates(snapshot));
    this.#stateWrite = write.catch(() => undefined);
    await write;
  }

  async #clearStoredResultForNewCapture(tabId: number): Promise<void> {
    await this.#withResultLock(async () => {
      await this.#store.clear(tabId);
      await this.#scheduleNextResultExpiry();
    });
  }

  async #scheduleNextResultExpiry(storedPlans?: readonly StoredRenderPlan[]): Promise<void> {
    const plans = storedPlans ?? (await this.#store.getAll());
    const nextExpiry = plans.reduce(
      (earliest, stored) => Math.min(earliest, stored.expiresAt),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextExpiry)) {
      await this.#platform.scheduleResultExpiry(nextExpiry);
    } else {
      await this.#platform.clearResultExpiry();
    }
  }

  #acceptsIdentity(identity: CaptureRunIdentity): boolean {
    const current = this.#sessions.get(identity.tabId)?.identity;
    return (
      current?.runId === identity.runId &&
      current.tabId === identity.tabId &&
      current.documentId === identity.documentId
    );
  }

  async #withResultLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#resultLock;
    let release: () => void = () => undefined;
    this.#resultLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #resolveTabId(tabId?: number): number | null {
    if (Number.isInteger(tabId)) return tabId ?? null;
    const candidates = new Set([...this.#states.keys(), ...this.#sessions.keys()]);
    return candidates.size === 1 ? candidates.values().next().value ?? null : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
