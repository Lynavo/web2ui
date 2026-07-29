import { describe, expect, it } from "vitest";
import {
  CAPTURE_MODES,
  CONTENT_MESSAGE_TYPES,
  POPUP_MESSAGE_TYPES,
  isPopupMessage,
} from "../src/extension/types.js";

describe("standalone extension message protocol", () => {
  it("exposes only Visible Area and Full Page capture modes", () => {
    expect(CAPTURE_MODES).toEqual(["visible-area", "full-page"]);
  });

  it("contains no account, task, upload, retry, deletion, or plugin actions", () => {
    expect(POPUP_MESSAGE_TYPES).toEqual([
      "get-state",
      "get-active-tab-viewport",
      "start-capture",
      "prepare-clipboard",
      "clear-result",
    ]);
    expect(CONTENT_MESSAGE_TYPES).toEqual([
      "capture-progress",
      "capture-done",
      "capture-error",
      "capture-element-screenshot",
      "fetch-asset",
    ]);
  });

  it("validates popup messages at the service-worker boundary", () => {
    expect(isPopupMessage({ type: "get-state" })).toBe(true);
    expect(isPopupMessage({ type: "get-active-tab-viewport" })).toBe(true);
    expect(
      isPopupMessage({
        type: "start-capture",
        mode: "visible-area",
        options: {
          viewports: [{ id: "browser", label: "Browser", widthPx: null, source: "browser" }],
          themes: [{ id: "browser", label: "Browser", source: "browser" }],
        },
      }),
    ).toBe(true);
    expect(isPopupMessage({ type: "prepare-clipboard", tabId: 42 })).toBe(true);
    expect(isPopupMessage({ type: "clear-result", tabId: 42 })).toBe(true);
    expect(isPopupMessage({ type: "prepare-clipboard" })).toBe(false);
    expect(isPopupMessage({ type: "clear-result", tabId: -1 })).toBe(false);
    expect(isPopupMessage({ type: "start-capture", mode: "selection" })).toBe(false);
    expect(isPopupMessage({ type: "send-to-figma" })).toBe(false);
    expect(isPopupMessage({ type: "retry" })).toBe(false);
    expect(isPopupMessage({ type: "get-state", extra: true })).toBe(false);
  });
});
