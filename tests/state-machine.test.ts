import { describe, expect, it } from "vitest";
import {
  EXTENSION_STATUSES,
  initialExtensionState,
  isExtensionState,
  reduceExtensionState,
  type CaptureRunIdentity,
  type ExtensionState,
} from "../src/extension/state-machine.js";

const identity: CaptureRunIdentity = {
  runId: "run_current",
  tabId: 42,
  documentId: "document_current",
};

describe("local-only extension state machine", () => {
  it("contains only the confirmed local capture and clipboard states", () => {
    expect(EXTENSION_STATUSES).toEqual([
      "idle",
      "capturing",
      "converting",
      "ready",
      "preparing-clipboard",
      "error",
    ]);
  });

  it("follows capture, conversion, and repeatable clipboard transitions", () => {
    let state: ExtensionState = initialExtensionState();
    state = reduceExtensionState(state, {
      type: "start-capture",
      identity,
      mode: "visible-area",
      startedAt: 100,
    });
    expect(state.status).toBe("capturing");

    state = reduceExtensionState(state, { type: "capture-complete", identity });
    expect(state.status).toBe("converting");

    state = reduceExtensionState(state, {
      type: "conversion-complete",
      identity,
      createdAt: 200,
      expiresAt: 300,
      warningCount: 2,
    });
    expect(state.status).toBe("ready");

    state = reduceExtensionState(state, { type: "prepare-clipboard", identity });
    expect(state.status).toBe("preparing-clipboard");

    state = reduceExtensionState(state, { type: "clipboard-complete", identity });
    expect(state).toMatchObject({ status: "ready", copyResult: "copied" });

    state = reduceExtensionState(state, { type: "prepare-clipboard", identity });
    state = reduceExtensionState(state, {
      type: "clipboard-failed",
      identity,
      message: "Clipboard permission was denied",
    });
    expect(state).toMatchObject({
      status: "ready",
      copyResult: "failed",
      copyError: "Clipboard permission was denied",
    });
  });

  it("ignores messages from a stale run, tab, or document", () => {
    const capturing = reduceExtensionState(initialExtensionState(), {
      type: "start-capture",
      identity,
      mode: "full-page",
      startedAt: 100,
    });

    for (const staleIdentity of [
      { ...identity, runId: "run_stale" },
      { ...identity, tabId: 99 },
      { ...identity, documentId: "document_stale" },
    ]) {
      expect(
        reduceExtensionState(capturing, {
          type: "capture-complete",
          identity: staleIdentity,
        }),
      ).toBe(capturing);
    }
  });

  it("preserves the ready result when clipboard preparation fails", () => {
    let state: ExtensionState = reduceExtensionState(initialExtensionState(), {
      type: "start-capture",
      identity,
      mode: "visible-area",
      startedAt: 100,
    });
    state = reduceExtensionState(state, { type: "capture-complete", identity });
    state = reduceExtensionState(state, {
      type: "conversion-complete",
      identity,
      createdAt: 200,
      expiresAt: 300,
      warningCount: 0,
    });
    state = reduceExtensionState(state, { type: "prepare-clipboard", identity });
    state = reduceExtensionState(state, {
      type: "clipboard-failed",
      identity,
      message: "Try again",
    });

    expect(state.status).toBe("ready");
    expect("runId" in state ? state.runId : null).toBe(identity.runId);
  });

  it("validates states before restoring them from extension storage", () => {
    expect(isExtensionState({ status: "idle" })).toBe(true);
    expect(isExtensionState({ status: "error", code: "unsupported-page", message: "Blocked" })).toBe(true);
    expect(isExtensionState({
      status: "ready",
      ...identity,
      mode: "visible-area",
      createdAt: 200,
      expiresAt: 300,
      warningCount: 0,
      copyResult: "copied",
    })).toBe(true);

    expect(isExtensionState(null)).toBe(false);
    expect(isExtensionState({ status: "idle", tabId: 42 })).toBe(false);
    expect(isExtensionState({ status: "error", code: "unknown", message: "Blocked" })).toBe(false);
    expect(isExtensionState({
      status: "capturing",
      ...identity,
      mode: "visible-area",
      startedAt: 100,
      progress: 2,
      label: "Invalid progress",
    })).toBe(false);
    expect(isExtensionState({
      status: "ready",
      ...identity,
      mode: "visible-area",
      createdAt: 200,
      expiresAt: 300,
      warningCount: -1,
    })).toBe(false);
  });
});
