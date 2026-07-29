import { useCallback, useEffect, useState } from "react";
import type { CaptureMode, ExtensionState } from "../state-machine.js";
import type { FigmaClipboardPayload, PopupResponse } from "../types.js";
import {
  THEME_OPTIONS,
  VIEWPORT_OPTIONS,
  buildCaptureOptions,
  formatThemeChip,
  formatViewportChip,
  type OptionIcon,
  type ThemeChoice,
  type ViewportChoice,
} from "./capture-options.js";
import { writeFigmaClipboardPayload } from "./clipboard.js";
import {
  CommercialEditionLink,
  canSuggestManagedRecovery,
} from "./commercial-edition.js";

type CopyStatus = "idle" | "copying" | "copied" | "error";

export interface PopupViewProps {
  state: ExtensionState;
  viewport: ViewportChoice;
  theme: ThemeChoice;
  browserViewportWidth: number | null;
  copyStatus: CopyStatus;
  version: string;
  onViewportChange: (viewport: ViewportChoice) => void;
  onThemeChange: (theme: ThemeChoice) => void;
  onCapture: (mode: CaptureMode) => void;
  onCopy: () => void;
  onClear: () => void;
}

export function PopupView(props: PopupViewProps) {
  const busy = props.state.status === "capturing" || props.state.status === "converting";
  const ready = props.state.status === "ready" || props.state.status === "preparing-clipboard";

  return (
    <div className="root" data-version={props.version}>
      <header className="topbar">
        <div className="brand-block">
          <img className="brand-logo" src="icons/icon-48.png" alt="" draggable={false} />
          <span className="brand-name">Web2UI</span>
        </div>
        <CommercialEditionLink
          className="commercial-header-link"
          label="Web2UI Cloud"
          ariaLabel="Open the commercial Web2UI Cloud edition in a new tab"
        />
      </header>

      {ready ? (
        <ReadyPanel {...props} />
      ) : busy ? (
        <ProgressView state={props.state} />
      ) : (
        <CapturePanel {...props} />
      )}
    </div>
  );
}

function CapturePanel(props: PopupViewProps) {
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const error = props.state.status === "error" ? props.state : null;
  const viewportLabel = formatViewportChip(props.viewport, props.browserViewportWidth);
  const themeLabel = formatThemeChip(props.theme);

  return (
    <main className="main">
      {error ? (
        <div className="error-banner" role="alert">
          <span className="error-dot">!</span>
          <div className="error-content">
            <div className="error-title">Capture failed</div>
            <div className="error-detail">{error.message}</div>
            {canSuggestManagedRecovery(error.code) ? (
              <CommercialEditionLink
                className="error-commercial-link"
                label="Try managed capture in Web2UI Cloud"
                ariaLabel="Try managed capture in the commercial Web2UI Cloud edition"
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="env-card">
        <div className="env-head">
          <span className="env-title">Viewport and Theme</span>
          <button
            type="button"
            className={environmentOpen ? "env-toggle active" : "env-toggle"}
            aria-expanded={environmentOpen}
            aria-controls="capture-environment-options"
            aria-label="Browser viewport and Browser theme"
            onClick={() => setEnvironmentOpen((open) => !open)}
          >
            <Icon name="sliders" size={13} />
          </button>
        </div>
        <div className="env-chips">
          <span className="env-chip">⚡ {viewportLabel}</span>
          <span className="env-chip">🎨 {themeLabel}</span>
        </div>
        {environmentOpen ? <div className="env-panel" id="capture-environment-options">
          <div className="env-group">
            <span className="env-legend">Viewport · choose one</span>
            <div className="env-grid-2" role="radiogroup" aria-label="Capture viewport">
              {VIEWPORT_OPTIONS.map((option) => (
                <EnvironmentOption
                  key={option.id}
                  label={option.label.split(" ")[0]!}
                  meta={
                    option.id === "browser"
                      ? formatViewportChip("browser", props.browserViewportWidth)
                      : `${option.widthPx}px`
                  }
                  icon={option.icon}
                  selected={props.viewport === option.id}
                  onClick={() => props.onViewportChange(option.id)}
                />
              ))}
            </div>
          </div>
          <div className="env-group">
            <span className="env-legend">Theme · choose one</span>
            <div className="env-grid-3" role="radiogroup" aria-label="Capture theme">
              {THEME_OPTIONS.map((option) => (
                <EnvironmentOption
                  key={option.id}
                  label={option.label}
                  icon={option.icon}
                  centered
                  selected={props.theme === option.id}
                  onClick={() => props.onThemeChange(option.id)}
                />
              ))}
            </div>
          </div>
        </div> : null}
      </section>

      <div className="mode-stack">
        <div className="mode-row">
          <button
            type="button"
            className="mode-primary"
            aria-label="Capture full page"
            onClick={() => props.onCapture("full-page")}
          >
            <span className="mode-primary-icon"><Icon name="camera" size={19} /></span>
            <span className="mode-card-text">
              <span className="mode-card-title">Full Page</span>
              <span className="mode-card-desc">Scrolls &amp; maps site</span>
            </span>
            <span className="mode-arrow-circle light" aria-hidden="true"><Icon name="arrow" size={13} /></span>
          </button>

          <button
            type="button"
            className="mode-secondary"
            aria-label="Capture visible area"
            onClick={() => props.onCapture("visible-area")}
          >
            <span className="mode-secondary-icon"><Icon name="monitor" size={19} /></span>
            <span className="mode-card-text">
              <span className="mode-card-title dark">Visible Area</span>
              <span className="mode-card-desc muted">Capture current viewport</span>
            </span>
            <span className="mode-arrow-circle bordered" aria-hidden="true"><Icon name="arrow" size={13} /></span>
          </button>
        </div>
      </div>

      <section className="guide-card">
        <span className="guide-title">Quick Guide</span>
        <div className="guide-steps">
          <GuideStep number="1" title="Choose a mode" description="Visible area or full page." icon="scan" />
          <div className="guide-divider" aria-hidden="true" />
          <GuideStep number="2" title="Adjust settings" description="Pick one viewport and theme." icon="sliders" />
          <div className="guide-divider" aria-hidden="true" />
          <GuideStep number="3" title="Copy for Figma" description="Paste editable layers." icon="copy" />
        </div>
      </section>
    </main>
  );
}

function EnvironmentOption({
  label,
  meta,
  icon,
  selected,
  centered = false,
  onClick,
}: {
  label: string;
  meta?: string;
  icon: OptionIcon;
  selected: boolean;
  centered?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`env-opt ${centered ? "center" : ""} ${selected ? "on" : ""}`.trim()}
      role="radio"
      aria-checked={selected}
      aria-label={meta ? `${label} ${meta}` : label}
      onClick={onClick}
    >
      <span className="env-opt-left">
        <span className={selected ? "env-radio checked" : "env-radio"} aria-hidden="true" />
        <Icon name={icon} size={13} />
        {label}
      </span>
      {meta ? <span className="env-opt-width">{meta}</span> : null}
    </button>
  );
}

function GuideStep({
  number,
  title,
  description,
  icon,
}: {
  number: string;
  title: string;
  description: string;
  icon: IconName;
}) {
  return (
    <div className="guide-step">
      <div className="guide-step-icons">
        <span className="guide-num">{number}</span>
        <span className="guide-icon"><Icon name={icon} size={15} /></span>
      </div>
      <div className="guide-step-text">
        <span className="guide-step-title">{title}</span>
        <span className="guide-step-desc">{description}</span>
      </div>
    </div>
  );
}

function ProgressView({ state }: { state: ExtensionState }) {
  const converting = state.status === "converting";
  const progress = state.status === "capturing" ? state.progress : 0.84;
  const label = state.status === "capturing" ? state.label : "Building local Figma payload";
  const percent = Math.round(progress * 100);
  return (
    <main className="main center progress-view" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <h1>{converting ? "Making editable layers" : "Reading the page"}</h1>
      <p className="progress-label">{label}</p>
      <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-value">{percent}% · Keep this tab open</span>
    </main>
  );
}

function ReadyPanel(props: PopupViewProps) {
  const state = props.state;
  const warningCount = "warningCount" in state ? state.warningCount : 0;
  const copyLabel =
    props.copyStatus === "copying"
      ? "Preparing clipboard…"
      : props.copyStatus === "copied"
        ? "Copied — paste in Figma"
        : "Copy for Figma";
  return (
    <main className="result-main result-view">
      <section className="capture-ready-hero">
        <div className="confetti" aria-hidden="true">
          <span className="confetti-dot cyan" />
          <span className="confetti-diamond amber" />
          <span className="confetti-dot green" />
          <span className="confetti-square violet" />
          <span className="confetti-dot coral" />
          <span className="confetti-dot lavender" />
        </div>
        <div className="ready-icon" aria-hidden="true"><Icon name="check" size={30} /></div>
        <div className="ready-copy">
          <h1>Capture ready!</h1>
          <p>Your editable capture is ready to paste into Figma.</p>
        </div>
      </section>

      {warningCount > 0 ? (
        <div className="warning-note" role="note">
          <span>{warningCount} visual detail{warningCount === 1 ? "" : "s"} used a safe approximation.</span>
          <CommercialEditionLink
            className="warning-commercial-link"
            label="Higher fidelity with Web2UI Cloud"
            ariaLabel="Explore higher-fidelity managed capture in the commercial Web2UI Cloud edition"
          />
        </div>
      ) : null}

      <button
        type="button"
        className="result-copy-card"
        data-status={props.copyStatus}
        disabled={props.copyStatus === "copying" || state.status === "preparing-clipboard"}
        onClick={props.onCopy}
      >
        <span className="result-card-icon"><Icon name="copy" size={22} /></span>
        <span className="result-card-body">
          <span className="result-card-title">{copyLabel}</span>
          <span className="result-card-desc">Paste onto your Figma canvas</span>
        </span>
        <span className="result-card-arrow" aria-hidden="true"><Icon name="arrow" size={16} /></span>
      </button>
      <p className={props.copyStatus === "error" ? "result-storage error" : "result-storage"} aria-live="polite">
        {props.copyStatus === "error" ? "Clipboard access failed. Your local result is still ready." : "Stored locally for up to 24 hours."}
      </p>

      <div className="result-footer">
        <button type="button" className="capture-again-btn" onClick={props.onClear}>
          <Icon name="arrow-left" size={14} />
          Capture another page
        </button>
        <button type="button" className="clear-data-btn" onClick={props.onClear}>Clear local data</button>
      </div>
    </main>
  );
}

type IconName =
  | "arrow"
  | "arrow-left"
  | "camera"
  | "check"
  | "copy"
  | "laptop"
  | "monitor"
  | "moon"
  | "scan"
  | "sliders"
  | "smartphone"
  | "sun"
  | "tablet";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "arrow") return <svg {...shared}><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
  if (name === "arrow-left") return <svg {...shared}><path d="M19 12H5m7 7-7-7 7-7" /></svg>;
  if (name === "camera") return <svg {...shared}><path d="M4 7h3l1.5-2h7L17 7h3v12H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
  if (name === "check") return <svg {...shared} strokeWidth={3}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === "copy") return <svg {...shared}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
  if (name === "laptop") return <svg {...shared}><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></svg>;
  if (name === "monitor") return <svg {...shared}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>;
  if (name === "moon") return <svg {...shared}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>;
  if (name === "scan") return <svg {...shared}><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /></svg>;
  if (name === "smartphone") return <svg {...shared}><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></svg>;
  if (name === "sun") return <svg {...shared}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>;
  if (name === "tablet") return <svg {...shared}><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M12 18h.01" /></svg>;
  return <svg {...shared}><path d="M4 6h10M18 6h2M4 12h2m4 0h10M4 18h7m4 0h5" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="18" r="2" /></svg>;
}

export function App() {
  const maybeChrome = globalThis.chrome as typeof chrome | undefined;
  const extensionApi =
    typeof maybeChrome?.runtime?.getManifest === "function" &&
    typeof maybeChrome.runtime.sendMessage === "function" &&
    maybeChrome.storage?.onChanged
      ? maybeChrome
      : null;
  const [state, setState] = useState<ExtensionState>({ status: "idle" });
  const [viewport, setViewport] = useState<ViewportChoice>("browser");
  const [theme, setTheme] = useState<ThemeChoice>("browser");
  const [browserViewportWidth, setBrowserViewportWidth] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const version = extensionApi?.runtime.getManifest().version ?? "0.1.3";

  const refresh = useCallback(async () => {
    if (!extensionApi) return;
    const response = (await extensionApi.runtime.sendMessage({ type: "get-state" })) as PopupResponse | undefined;
    if (response?.ok && "state" in response) setState(response.state);
  }, [extensionApi]);

  const refreshActiveViewport = useCallback(async () => {
    if (!extensionApi) return;
    const response = (await extensionApi.runtime.sendMessage({
      type: "get-active-tab-viewport",
    })) as PopupResponse | undefined;
    if (response?.ok && "viewport" in response) {
      setBrowserViewportWidth(response.viewport?.widthPx ?? null);
    }
  }, [extensionApi]);

  useEffect(() => {
    if (!extensionApi) return undefined;
    void refresh();
    const listener = () => void refresh();
    extensionApi.storage.onChanged.addListener(listener);
    return () => extensionApi.storage.onChanged.removeListener(listener);
  }, [extensionApi, refresh]);

  useEffect(() => {
    void refreshActiveViewport();
    const onFocus = () => void refreshActiveViewport();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshActiveViewport]);

  useEffect(() => {
    if (state.status !== "capturing" && state.status !== "converting") return;
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [refresh, state.status]);

  const onCapture = async (captureMode: CaptureMode) => {
    if (!extensionApi) return;
    setCopyStatus("idle");
    const response = (await extensionApi.runtime.sendMessage({
      type: "start-capture",
      mode: captureMode,
      options: buildCaptureOptions(viewport, theme),
    })) as PopupResponse;
    if (response.ok && "state" in response) setState(response.state);
    else await refresh();
  };

  const onCopy = async () => {
    if (!extensionApi) return;
    if (!("tabId" in state)) return;
    setCopyStatus("copying");
    try {
      const response = (await extensionApi.runtime.sendMessage({
        type: "prepare-clipboard",
        tabId: state.tabId,
      })) as PopupResponse;
      if (!response.ok || !("payload" in response)) throw new Error("Clipboard payload unavailable");
      await writeFigmaClipboardPayload(response.payload as FigmaClipboardPayload);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 2_500);
    } catch {
      setCopyStatus("error");
    } finally {
      await refresh();
    }
  };

  const onClear = async () => {
    if (!extensionApi) return;
    if (!("tabId" in state)) return;
    const response = (await extensionApi.runtime.sendMessage({
      type: "clear-result",
      tabId: state.tabId,
    })) as PopupResponse;
    if (response.ok) setState({ status: "idle" });
    setCopyStatus("idle");
  };

  return (
    <PopupView
      state={state}
      viewport={viewport}
      theme={theme}
      browserViewportWidth={browserViewportWidth}
      copyStatus={copyStatus}
      version={version}
      onViewportChange={setViewport}
      onThemeChange={setTheme}
      onCapture={(captureMode) => void onCapture(captureMode)}
      onCopy={() => void onCopy()}
      onClear={() => void onClear()}
    />
  );
}
